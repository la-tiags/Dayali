//! Rappels V1 : un fichier JSON par rappel, un fichier par liste (PLAN §4.5).
//!
//! Emplacements :
//!  - `reminders/<reminderId>.json` ;
//!  - `reminders/lists/<listId>.json` ;
//!  - corbeille `.dayali/trash/reminders/<reminderId>.json` (et
//!    `.dayali/trash/reminders/lists/<listId>.json` pour une liste).
//!
//! Règles absolues :
//!  - un identifiant est validé **avant** de construire un chemin (UUID
//!    minuscule) : jamais de `/`, `\` ou `..` ;
//!  - toute écriture passe par [`crate::vault::atomic::write_vault_bytes`] avec
//!    une précondition explicite en mise à jour ; sans `expected`, un fichier
//!    existant n'est jamais écrasé ;
//!  - un refus de précondition conserve la version entrante dans une copie
//!    `.conflict-*` (best-effort) et renvoie `E_PRECONDITION_FAILED` avec
//!    `details.current` ;
//!  - une suppression déplace vers la corbeille, elle ne supprime jamais le
//!    fichier sans l'avoir déplacé ;
//!  - la liste par défaut n'est créée qu'une fois, paresseusement, par
//!    [`list_defs`], avec un identifiant stable pour ne pas dupliquer « À faire »
//!    entre machines ;
//!  - aucune récurrence n'est écrite en V1 (`E_UNSUPPORTED`).
//!
//! Aucune fonction ne renvoie un succès factice : un fichier absent est
//! `E_NOT_FOUND`, un fichier invalide est `E_SCHEMA_INVALID` avec son chemin.

use std::path::Path;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use uuid::Uuid;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{
    is_local_date, is_project_id, is_sha256_hex, is_uuid, nfc, parse_iso, to_iso, FileRef,
    Precondition,
};
use crate::models::reminders::{
    Reminder, ReminderList, ReminderRecurrence, ReminderStatus, RemindersFilter,
};
use crate::services::{self, day as svc_day};
use crate::vault::{atomic, fs as vault_fs, paths as vault_paths};

/// Dossier des rappels (relatif au vault).
pub const REMINDERS_DIR: &str = "reminders";
/// Dossier des définitions de listes.
pub const LISTS_DIR: &str = "reminders/lists";
/// Corbeille des rappels.
pub const TRASH_REMINDERS_DIR: &str = ".dayali/trash/reminders";
/// Corbeille des listes.
pub const TRASH_LISTS_DIR: &str = ".dayali/trash/reminders/lists";

/// Identifiant stable de la liste par défaut (« À faire »).
///
/// Fixe volontairement : deux machines qui explorent un vault neuf avant toute
/// synchronisation créent ainsi le **même** fichier au lieu de deux listes
/// « À faire » distinctes. L'identifiant respecte le motif UUID de `common`.
pub const DEFAULT_LIST_ID: &str = "0199a1b2-7ff0-7a01-8a01-000000000001";
/// Nom de la liste par défaut.
pub const DEFAULT_LIST_NAME: &str = "À faire";

/// Plafond de lecture d'un rappel : notes ≤ 20 000 caractères, donc très large.
pub const MAX_REMINDER_BYTES: usize = 256 * 1024;
/// Plafond de lecture d'une liste.
pub const MAX_LIST_BYTES: usize = 64 * 1024;

const MAX_TITLE_CHARS: usize = 200;
const MAX_NOTES_CHARS: usize = 20_000;
const MAX_LIST_NAME_CHARS: usize = 60;
const MAX_SORT_KEY_CHARS: usize = 64;
const MAX_LIST_ORDER: i32 = 10_000;
const MAX_CONFLICT_ATTEMPTS: usize = 100;

// ---------------------------------------------------------------------------
// Helpers de chemin et de validation
// ---------------------------------------------------------------------------

fn reminder_rel_path(id: &str) -> String {
    format!("{REMINDERS_DIR}/{id}.json")
}

fn list_rel_path(id: &str) -> String {
    format!("{LISTS_DIR}/{id}.json")
}

/// Valide un identifiant d'entité avant toute construction de chemin.
fn validate_entity_id(id: &str, path: &str) -> Result<(), DayaliError> {
    if !is_uuid(id) {
        return Err(DayaliError::schema_invalid(
            path,
            "identifiant UUID minuscule attendu (ni /, ni \\, ni ..)",
        ));
    }
    Ok(())
}

fn validate_expected(expected: Option<&str>) -> Result<(), DayaliError> {
    if let Some(expected) = expected {
        if !is_sha256_hex(expected) {
            return Err(DayaliError::schema_invalid(
                "/expected",
                "hash attendu : SHA-256 hexadécimal minuscule de 64 caractères",
            ));
        }
    }
    Ok(())
}

fn validate_local_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let digits = |slice: &[u8]| slice.iter().all(u8::is_ascii_digit);
    if !digits(&bytes[0..2]) || !digits(&bytes[3..5]) {
        return false;
    }
    let hour = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
    let minute = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
    hour < 24 && minute < 60
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_timestamp(value: &str, path: &str) -> Result<(), DayaliError> {
    parse_iso(value).map_err(|_| {
        DayaliError::schema_invalid(
            path,
            "horodatage UTC RFC 3339 avec suffixe Z attendu (ex. 2026-10-27T08:00:00.000Z)",
        )
    })?;
    Ok(())
}

fn validate_recurrence(recurrence: &ReminderRecurrence) -> Result<(), DayaliError> {
    if !(1..=365).contains(&recurrence.interval) {
        return Err(DayaliError::schema_invalid(
            "/recurrence/interval",
            "interval doit être compris entre 1 et 365",
        ));
    }
    if recurrence.weekdays.len() > 7 {
        return Err(DayaliError::schema_invalid(
            "/recurrence/weekdays",
            "weekdays ne peut contenir plus de 7 jours",
        ));
    }
    let mut seen = [false; 8];
    for weekday in &recurrence.weekdays {
        if !(1..=7).contains(weekday) {
            return Err(DayaliError::schema_invalid(
                "/recurrence/weekdays",
                "weekdays attend des entiers ISO 1–7",
            ));
        }
        if seen[*weekday as usize] {
            return Err(DayaliError::schema_invalid(
                "/recurrence/weekdays",
                "weekdays ne peut pas contenir de doublon",
            ));
        }
        seen[*weekday as usize] = true;
    }
    if let Some(until) = &recurrence.until_date {
        if !is_local_date(until) {
            return Err(DayaliError::schema_invalid(
                "/recurrence/untilDate",
                "untilDate doit être une date civile YYYY-MM-DD valide",
            ));
        }
    }
    if let Some(count) = recurrence.count {
        if !(1..=1000).contains(&count) {
            return Err(DayaliError::schema_invalid(
                "/recurrence/count",
                "count doit être compris entre 1 et 1000",
            ));
        }
    }
    if svc_day::parse_time_zone(&recurrence.time_zone).is_none() {
        return Err(DayaliError::schema_invalid(
            "/recurrence/timeZone",
            "fuseau IANA valide attendu",
        ));
    }
    Ok(())
}

/// Valide un rappel.
///
/// `for_write = true` ajoute l'invariant du writer V1 : la liste doit exister.
/// La récurrence est validée quand elle est présente (forme V2 lue sur disque) ;
/// le refus d'une récurrence **entrante** non nulle est fait par [`save`] avant
/// cette validation, pour ne pas confondre une valeur lue et une valeur reçue.
fn validate_reminder(root: &Path, reminder: &Reminder, for_write: bool) -> Result<(), DayaliError> {
    if reminder.schema_version != crate::models::common::SCHEMA_VERSION {
        return Err(DayaliError::schema_invalid(
            "/schemaVersion",
            "schemaVersion inconnu pour un rappel",
        ));
    }
    validate_entity_id(&reminder.id, "/id")?;
    validate_entity_id(&reminder.list_id, "/listId")?;

    let title_len = reminder.title.trim().chars().count();
    if title_len == 0 {
        return Err(DayaliError::schema_invalid(
            "/title",
            "le titre du rappel ne peut pas être vide",
        ));
    }
    if reminder.title.chars().count() > MAX_TITLE_CHARS {
        return Err(DayaliError::schema_invalid(
            "/title",
            format!("le titre du rappel dépasse {MAX_TITLE_CHARS} caractères"),
        ));
    }
    if let Some(notes) = &reminder.notes {
        if notes.chars().count() > MAX_NOTES_CHARS {
            return Err(DayaliError::schema_invalid(
                "/notes",
                format!("les notes dépassent {MAX_NOTES_CHARS} caractères"),
            ));
        }
    }

    if let Some(due_date) = &reminder.due_date {
        if !is_local_date(due_date) {
            return Err(DayaliError::schema_invalid(
                "/dueDate",
                "dueDate doit être une date civile YYYY-MM-DD valide",
            ));
        }
    }
    if let Some(due_time) = &reminder.due_time {
        if !validate_local_time(due_time) {
            return Err(DayaliError::schema_invalid(
                "/dueTime",
                "dueTime doit être une heure locale HH:mm valide",
            ));
        }
        if reminder.due_date.is_none() {
            return Err(DayaliError::schema_invalid(
                "/dueDate",
                "une heure sans date n'est pas portable : dueDate est obligatoire",
            ));
        }
        let Some(time_zone) = reminder.due_time_zone.as_deref() else {
            return Err(DayaliError::schema_invalid(
                "/dueTimeZone",
                "une heure sans fuseau n'est pas portable : dueTimeZone est obligatoire",
            ));
        };
        if svc_day::parse_time_zone(time_zone).is_none() {
            return Err(DayaliError::schema_invalid(
                "/dueTimeZone",
                "dueTimeZone doit être un identifiant IANA valide",
            ));
        }
    }

    match &reminder.status {
        ReminderStatus::Done => {
            let Some(completed_at) = &reminder.completed_at else {
                return Err(DayaliError::schema_invalid(
                    "/completedAt",
                    "completedAt est obligatoire quand status=done",
                ));
            };
            validate_timestamp(completed_at, "/completedAt")?;
        }
        ReminderStatus::Open | ReminderStatus::Cancelled | ReminderStatus::Abandoned => {
            if reminder.completed_at.is_some() {
                return Err(DayaliError::schema_invalid(
                    "/completedAt",
                    "completedAt doit être null quand status=open|cancelled|abandoned",
                ));
            }
        }
        ReminderStatus::Unknown(_) if for_write => {
            return Err(DayaliError::schema_invalid(
                "/status",
                "statut inconnu non modifiable",
            ));
        }
        ReminderStatus::Unknown(_) => {}
    }

    if let Some(recurrence) = &reminder.recurrence {
        validate_recurrence(recurrence)?;
    }

    if let Some(project_id) = &reminder.project_id {
        if !is_project_id(project_id) {
            return Err(DayaliError::schema_invalid(
                "/projectId",
                "projectId doit respecter le motif <slug>--<8 hex> (minuscules, 11 à 58 caractères)",
            ));
        }
    }
    if let Some(sort_key) = &reminder.sort_key {
        if sort_key.chars().count() > MAX_SORT_KEY_CHARS {
            return Err(DayaliError::schema_invalid(
                "/sortKey",
                format!("sortKey dépasse {MAX_SORT_KEY_CHARS} caractères"),
            ));
        }
    }

    validate_timestamp(&reminder.created_at, "/createdAt")?;
    validate_timestamp(&reminder.updated_at, "/updatedAt")?;
    validate_entity_id(&reminder.machine_id, "/machineId")?;

    if for_write && !vault_fs::exists(root, &list_rel_path(&reminder.list_id)) {
        return Err(DayaliError::schema_invalid(
            "/listId",
            "listId inconnu : la liste n'existe pas dans reminders/lists/",
        ));
    }
    Ok(())
}

fn validate_list(list: &ReminderList) -> Result<(), DayaliError> {
    if list.schema_version != crate::models::common::SCHEMA_VERSION {
        return Err(DayaliError::schema_invalid(
            "/schemaVersion",
            "schemaVersion inconnu pour une liste de rappels",
        ));
    }
    validate_entity_id(&list.id, "/id")?;
    let name_len = list.name.trim().chars().count();
    if name_len == 0 {
        return Err(DayaliError::schema_invalid(
            "/name",
            "le nom de la liste ne peut pas être vide",
        ));
    }
    if list.name.chars().count() > MAX_LIST_NAME_CHARS {
        return Err(DayaliError::schema_invalid(
            "/name",
            format!("le nom de la liste dépasse {MAX_LIST_NAME_CHARS} caractères"),
        ));
    }
    if !(0..=MAX_LIST_ORDER).contains(&list.order) {
        return Err(DayaliError::schema_invalid(
            "/order",
            format!("order doit être compris entre 0 et {MAX_LIST_ORDER}"),
        ));
    }
    if let Some(color) = &list.color {
        if !is_hex_color(color) {
            return Err(DayaliError::schema_invalid(
                "/color",
                "color doit être au format #rrggbb",
            ));
        }
    }
    validate_timestamp(&list.created_at, "/createdAt")?;
    validate_timestamp(&list.updated_at, "/updatedAt")?;
    validate_entity_id(&list.machine_id, "/machineId")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/// Refuse un fichier dont l'`id` interne ne correspond pas à son nom.
///
/// Sans ce contrôle, `A.json` contenant `"id": "B"` produirait un rappel
/// fantôme : listé sous `B`, illisible sous `B` (le fichier cherché est
/// `B.json`) et impossible à supprimer proprement. Aucune écriture n'est tentée
/// pour « réparer » : le fichier est signalé, jamais réécrit en silence.
fn ensure_embedded_id(file_rel: &str, file_id: &str, embedded_id: &str) -> Result<(), DayaliError> {
    if embedded_id != file_id {
        return Err(DayaliError::schema_invalid(
            "/id",
            format!(
                "l'identifiant interne « {embedded_id} » ne correspond pas au fichier « {file_rel} »"
            ),
        ));
    }
    Ok(())
}

/// Lit et valide un rappel. `E_NOT_FOUND` si le fichier est absent.
pub fn read_reminder(root: &Path, id: &str) -> Result<Reminder, DayaliError> {
    validate_entity_id(id, "/id")?;
    let rel = reminder_rel_path(id);
    let (text, _) = vault_fs::read_text(root, &rel, MAX_REMINDER_BYTES)?;
    let reminder: Reminder = services::parse_json(&text, &rel)?;
    ensure_embedded_id(&rel, id, &reminder.id)?;
    validate_reminder(root, &reminder, false)?;
    Ok(reminder)
}

/// Lit et valide une liste. `E_NOT_FOUND` si le fichier est absent.
pub fn read_list(root: &Path, id: &str) -> Result<ReminderList, DayaliError> {
    validate_entity_id(id, "/id")?;
    let rel = list_rel_path(id);
    let (text, _) = vault_fs::read_text(root, &rel, MAX_LIST_BYTES)?;
    let list: ReminderList = services::parse_json(&text, &rel)?;
    ensure_embedded_id(&rel, id, &list.id)?;
    validate_list(&list)?;
    Ok(list)
}

fn is_conflict_name(name: &str) -> bool {
    name.contains(".conflict-")
}

fn json_files(dir: &Path) -> Result<Vec<String>, DayaliError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(DayaliError::from_io(
                &error,
                "dossier des rappels illisible",
            ))
        }
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| DayaliError::from_io(&error, "entrée du dossier illisible"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| DayaliError::from_io(&error, "type d'entrée illisible"))?;
        if !file_type.is_file() {
            // `lists/` est un sous-dossier, pas un rappel. Un symlink n'est pas
            // un fichier fiable : il est signalé par `read_reminder` à l'usage.
            continue;
        }
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        if name.ends_with(".json") && !is_conflict_name(&name) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn list_ids(dir: &Path) -> Result<Vec<String>, DayaliError> {
    Ok(json_files(dir)?
        .into_iter()
        .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
        .collect())
}

/// Trie les rappels sur place, dans l'ordre stable du service.
///
/// Tri : `dueDate` nulle en dernier, puis `dueTime`, puis `createdAt`, puis
/// `id` (déterministe même quand deux rappels ont la même échéance). Exposé
/// pour que les lectures partielles (reports de la veille) conservent
/// exactement l'ordre de [`list`].
pub fn sort_reminders(items: &mut [Reminder]) {
    items.sort_by(|left, right| {
        let left_key = (
            left.due_date.is_none(),
            left.due_date.clone().unwrap_or_default(),
            left.due_time.clone().unwrap_or_default(),
            left.created_at.clone(),
            left.id.clone(),
        );
        let right_key = (
            right.due_date.is_none(),
            right.due_date.clone().unwrap_or_default(),
            right.due_time.clone().unwrap_or_default(),
            right.created_at.clone(),
            right.id.clone(),
        );
        left_key.cmp(&right_key)
    });
}

/// Liste les rappels, filtre et trie de façon stable.
///
/// Tri : `dueDate` nulle en dernier, puis `dueTime`, puis `createdAt`, puis
/// `id` (déterministe même quand deux rappels ont la même échéance).
pub fn list(
    root: &Path,
    filter: Option<&RemindersFilter>,
    at: DateTime<Utc>,
    day_start_hour: u32,
    time_zone: Tz,
) -> Result<Vec<Reminder>, DayaliError> {
    let mut items = Vec::new();
    for id in list_ids(&root.join(REMINDERS_DIR))? {
        if !is_uuid(&id) {
            // Un fichier nommé autrement qu'un UUID n'est pas un rappel de
            // Dayali ; il est ignoré (mais jamais supprimé).
            continue;
        }
        items.push(read_reminder(root, &id)?);
    }

    // Les rappels abandonnés restent sur disque mais sont masqués des listes.
    items.retain(|item| item.status != ReminderStatus::Abandoned);
    if let Some(filter) = filter {
        if let Some(statuses) = &filter.statuses {
            if !statuses.is_empty() {
                items.retain(|item| statuses.contains(&item.status));
            }
        }
        if let Some(list_ids_filter) = &filter.list_ids {
            if !list_ids_filter.is_empty() {
                items.retain(|item| list_ids_filter.contains(&item.list_id));
            }
        }
        if let Some(due_within_days) = filter.due_within_days {
            if due_within_days < 0 {
                return Err(DayaliError::schema_invalid(
                    "/filter/dueWithinDays",
                    "dueWithinDays doit être supérieur ou égal à 0",
                ));
            }
            let day = svc_day::logical_day(at, day_start_hour, time_zone)?;
            let horizon = if due_within_days == 0 {
                None
            } else {
                let offset = u64::try_from(due_within_days - 1).map_err(|_| {
                    DayaliError::schema_invalid(
                        "/filter/dueWithinDays",
                        "dueWithinDays hors bornes",
                    )
                })?;
                Some(
                    day.checked_sub_days(chrono::Days::new(offset))
                        .ok_or_else(|| {
                            DayaliError::schema_invalid(
                                "/filter/dueWithinDays",
                                "dueWithinDays hors bornes calendaires",
                            )
                        })?,
                )
            };
            items.retain(|item| {
                let Some(due_date) = &item.due_date else {
                    return false;
                };
                let Ok(parsed) = chrono::NaiveDate::parse_from_str(due_date, "%Y-%m-%d") else {
                    return false;
                };
                if parsed > day {
                    return false;
                }
                match horizon {
                    None => true,
                    Some(horizon) => parsed >= horizon,
                }
            });
        }
    }

    sort_reminders(&mut items);
    Ok(items)
}

/// Lit tous les rappels en tolérant les fichiers illisibles, un par un.
///
/// Chaque fichier `reminders/<id>.json` est lu et validé indépendamment. Un
/// fichier illisible (JSON invalide, schéma incohérent, identifiant interne
/// différent du nom…) est **ignoré** et signalé par un avertissement lisible
/// contenant son identifiant et le code d'erreur ; il n'est jamais réécrit,
/// déplacé ni supprimé. Seule une erreur d'accès au dossier lui-même remonte en
/// erreur : l'appelant ne peut alors pas affirmer que la liste est complète.
///
/// L'ordre est celui de [`list`] : [`sort_reminders`] est appliqué à la fin.
pub fn list_tolerant(root: &Path) -> Result<(Vec<Reminder>, Vec<String>), DayaliError> {
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for id in list_ids(&root.join(REMINDERS_DIR))? {
        if !is_uuid(&id) {
            // Un fichier nommé autrement qu'un UUID n'est pas un rappel de
            // Dayali ; il est ignoré (mais jamais supprimé).
            continue;
        }
        match read_reminder(root, &id) {
            Ok(reminder) => {
                if let ReminderStatus::Unknown(status) = &reminder.status {
                    warnings.push(format!(
                        "reminders/{id}.json : statut inconnu «{status}» — rappel non modifiable"
                    ));
                }
                items.push(reminder)
            }
            Err(error) => warnings.push(format!(
                "reminders/{id}.json : {} — {}",
                error.code.as_str(),
                error.message
            )),
        }
    }
    sort_reminders(&mut items);
    Ok((items, warnings))
}

/// `FileRef` d'un rappel, hash **recalculé** (jamais un statut de confiance).
pub fn get_file_ref(root: &Path, id: &str) -> Result<FileRef, DayaliError> {
    validate_entity_id(id, "/id")?;
    vault_fs::file_ref(root, &reminder_rel_path(id))
}

// ---------------------------------------------------------------------------
// Copies de conflit
// ---------------------------------------------------------------------------

/// Écrit une copie `.conflict-*` de la version entrante, best-effort.
///
/// Ne masque jamais l'erreur principale : les échecs de copie sont ignorés. Le
/// nom suit la convention `<id>.conflict-<machine8><YYYYMMDDTHHMMSSZ>.json` ;
/// un suffixe numérique évite d'écraser une copie de la même seconde.
fn write_conflict_copy(
    root: &Path,
    dir_rel: &str,
    id: &str,
    bytes: &[u8],
    machine_id: &str,
    at: DateTime<Utc>,
) {
    let machine8: String = nfc(machine_id).chars().take(8).collect();
    let stamp = at.format("%Y%m%dT%H%M%SZ").to_string();
    for attempt in 0..MAX_CONFLICT_ATTEMPTS {
        let suffix = if attempt == 0 {
            format!("{machine8}{stamp}")
        } else {
            format!("{machine8}{stamp}-{attempt}")
        };
        let rel = format!("{dir_rel}/{id}.conflict-{suffix}.json");
        match atomic::write_vault_bytes(
            root,
            &rel,
            bytes,
            Some(&Precondition::must_not_exist()),
            true,
        ) {
            Ok(_) => return,
            Err(error) if error.code == ErrorCode::PreconditionFailed => continue,
            Err(_) => return,
        }
    }
}

fn serialize_pretty<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, DayaliError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        DayaliError::internal(format!("sérialisation JSON impossible : {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Met à jour uniquement les clés connues dans un document existant. Grâce à
/// `preserve_order`, les clés inconnues (y compris dans les objets imbriqués)
/// restent octet-stables autant que JSON permet, et ne sont jamais supprimées.
fn merge_known(dst: &mut serde_json::Value, src: serde_json::Value) {
    if let (Some(dst), Some(src)) = (dst.as_object_mut(), src.as_object()) {
        for (key, value) in src {
            if let Some(existing) = dst.get_mut(key) {
                if existing.is_object() && value.is_object() {
                    merge_known(existing, value.clone());
                    continue;
                }
            }
            dst.insert(key.clone(), value.clone());
        }
    }
}

fn serialize_reminder_preserving(
    root: &Path,
    id: &str,
    reminder: &Reminder,
) -> Result<Vec<u8>, DayaliError> {
    let next = serde_json::to_value(reminder)?;
    let rel = reminder_rel_path(id);
    let mut value = match vault_fs::read_text(root, &rel, MAX_REMINDER_BYTES) {
        Ok((text, _)) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
        Err(error) if error.code == ErrorCode::NotFound => serde_json::json!({}),
        Err(error) => return Err(error),
    };
    merge_known(&mut value, next);
    let mut bytes = serde_json::to_vec_pretty(&value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn precondition_missing(path: &str) -> DayaliError {
    DayaliError::new(
        ErrorCode::PreconditionFailed,
        "fichier absent : la version attendue n'existe plus (supprimé ou jamais écrit)",
    )
    .with_details(serde_json::json!({
        "current": serde_json::Value::Null,
        "currentRevision": serde_json::Value::Null,
        "path": path,
    }))
    .retryable()
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/// Crée ou met à jour un rappel.
///
/// - création (`expected == None`) : `id` vide → UUIDv7 ; `createdAt` fourni
///   s'il est RFC 3339 valide, sinon `at` ;
/// - mise à jour (`expected == Some(hash)`) : `createdAt` du fichier existant
///   fait foi ;
/// - `schemaVersion`, `machineId` et `updatedAt` sont toujours imposés ;
/// - une récurrence V2 déjà présente sur disque est **conservée** quand le
///   client V1 envoie `null` (il ne connaît pas le champ) ; une récurrence
///   entrante non nulle est toujours refusée (`E_UNSUPPORTED`) ;
/// - un échec de précondition écrit une copie `.conflict-*` puis renvoie
///   `E_PRECONDITION_FAILED` avec `details.current`.
pub fn save(
    root: &Path,
    incoming: Reminder,
    expected: Option<&str>,
    machine_id: &str,
    at: DateTime<Utc>,
) -> Result<Reminder, DayaliError> {
    validate_expected(expected)?;
    validate_entity_id(machine_id, "/machineId")?;
    // Le writer V1 refuse toute récurrence **entrante** : il ne sait pas la
    // produire. Une récurrence déjà sur disque est conservée plus bas, jamais
    // écrasée par `null`.
    if incoming.recurrence.is_some() {
        return Err(
            DayaliError::unsupported("récurrence non prise en charge en V1 (prévue V2)")
                .with_details(serde_json::json!({ "path": "/recurrence" })),
        );
    }

    let id = if incoming.id.is_empty() {
        Uuid::now_v7().to_string()
    } else {
        validate_entity_id(&incoming.id, "/id")?;
        incoming.id.clone()
    };

    let existing_bytes = std::fs::read(root.join(reminder_rel_path(&id))).ok();
    let existing = match read_reminder(root, &id) {
        Ok(reminder) => Some(reminder),
        Err(error) if error.code == ErrorCode::NotFound => None,
        Err(error) => return Err(error),
    };

    let created_at = if let Some(existing) = &existing {
        existing.created_at.clone()
    } else if expected.is_some() {
        let mut candidate = incoming.clone();
        candidate.id = id.clone();
        candidate.schema_version = crate::models::common::SCHEMA_VERSION;
        candidate.machine_id = machine_id.to_string();
        candidate.updated_at = to_iso(at);
        // Mise à jour d'un fichier disparu : rien n'est créé, la version
        // entrante est conservée en copie de conflit.
        if let Ok(bytes) = serialize_pretty(&candidate) {
            write_conflict_copy(root, REMINDERS_DIR, &id, &bytes, machine_id, at);
        }
        return Err(precondition_missing(&reminder_rel_path(&id)));
    } else {
        // Un `createdAt` fourni par l'UI n'est conservé que s'il est un instant
        // RFC 3339 valide ; sinon l'instant serveur fait foi (jamais de date
        // invalide écrite sur disque).
        parse_iso(&incoming.created_at)
            .map(to_iso)
            .unwrap_or_else(|_| to_iso(at))
    };

    let mut reminder = incoming;
    reminder.schema_version = crate::models::common::SCHEMA_VERSION;
    reminder.id = id.clone();
    reminder.created_at = created_at;
    reminder.updated_at = to_iso(at);
    reminder.machine_id = machine_id.to_string();

    // Ne détruis jamais une donnée V2 lue : un client V1 renvoie forcément
    // `recurrence: null` puisqu'il ne connaît pas le champ. La valeur du disque
    // fait donc foi quand l'entrée est nulle. Une récurrence entrante non nulle
    // a déjà été refusée plus haut (`E_UNSUPPORTED`), jamais écrasée ni ignorée.
    if reminder.recurrence.is_none() {
        if let Some(existing) = &existing {
            if existing.recurrence.is_some() {
                reminder.recurrence = existing.recurrence.clone();
            }
        }
    }

    validate_reminder(root, &reminder, true)?;
    let bytes = serialize_reminder_preserving(root, &id, &reminder)?;
    let precondition = expected.map(Precondition::hash);

    match atomic::write_vault_bytes(
        root,
        &reminder_rel_path(&id),
        &bytes,
        precondition.as_ref(),
        true,
    ) {
        // Retourne l'objet réellement écrit, jamais une relecture disque : une
        // autre machine pourrait écrire entre le `rename` et la relecture, et
        // `save` renverrait alors sa version au lieu de la nôtre. L'UI
        // afficherait E et adopterait le hash de E, perdant silencieusement S.
        Ok(_) => Ok(reminder),
        Err(error) if error.code == ErrorCode::PreconditionFailed => {
            // A conflict artifact is an exact byte copy of the on-disk
            // reminder, never a re-serialization (which could reorder or
            // normalize unknown extensions).
            if let Some(original) = existing_bytes.as_deref() {
                write_conflict_copy(root, REMINDERS_DIR, &id, original, machine_id, at);
            } else {
                write_conflict_copy(root, REMINDERS_DIR, &id, &bytes, machine_id, at);
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Déplace un fichier vers la corbeille, sans jamais écraser une entrée
/// existante (suffixe d'horodatage puis compteur).
fn move_to_trash(
    root: &Path,
    source_rel: &str,
    trash_dir_rel: &str,
    at: DateTime<Utc>,
) -> Result<(), DayaliError> {
    let source = root.join(source_rel);
    let file_name = source_rel
        .rsplit('/')
        .next()
        .ok_or_else(|| DayaliError::path_escape("chemin source sans nom de fichier"))?;
    let stem = file_name.strip_suffix(".json").unwrap_or(file_name);
    let stamp = at.format("%Y%m%dT%H%M%SZ").to_string();

    for attempt in 0..MAX_CONFLICT_ATTEMPTS {
        let name = match attempt {
            0 => file_name.to_string(),
            1 => format!("{stem}-{stamp}.json"),
            other => format!("{stem}-{stamp}-{other}.json"),
        };
        let trash_rel = format!("{trash_dir_rel}/{name}");
        match std::fs::symlink_metadata(root.join(&trash_rel)) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(DayaliError::from_io(&error, "corbeille inaccessible"));
            }
        }
        // `resolve_write` crée le dossier de corbeille sans traverser de symlink.
        let destination = vault_paths::resolve_write(root, &trash_rel, true)?;
        std::fs::rename(&source, &destination.absolute).map_err(|error| {
            DayaliError::from_io(&error, "déplacement vers la corbeille impossible")
        })?;
        return Ok(());
    }
    Err(DayaliError::internal(
        "corbeille saturée : impossible de trouver un nom de destination libre",
    ))
}

/// Supprime un rappel en le déplaçant dans la corbeille.
pub fn delete(root: &Path, id: &str, expected: &str, at: DateTime<Utc>) -> Result<(), DayaliError> {
    validate_entity_id(id, "/id")?;
    validate_expected(Some(expected))?;

    let rel = reminder_rel_path(id);
    let metadata = std::fs::symlink_metadata(root.join(&rel))
        .map_err(|error| DayaliError::from_io(&error, "rappel introuvable"))?;
    if metadata.file_type().is_symlink() {
        return Err(DayaliError::path_escape(
            "suppression refusée sur un symlink de rappel",
        ));
    }
    let current = vault_fs::file_ref(root, &rel)?;
    if current.hash != expected {
        return Err(services::precondition_failed(
            "le rappel a changé depuis la lecture : recharge avant de supprimer",
            &current,
        ));
    }
    move_to_trash(root, &rel, TRASH_REMINDERS_DIR, at)
}

// ---------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------

fn default_list(machine_id: &str, at: DateTime<Utc>) -> ReminderList {
    let timestamp = to_iso(at);
    ReminderList {
        schema_version: crate::models::common::SCHEMA_VERSION,
        id: DEFAULT_LIST_ID.to_string(),
        name: DEFAULT_LIST_NAME.to_string(),
        color: None,
        order: 0,
        archived: false,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        machine_id: machine_id.to_string(),
    }
}

/// Lit les définitions de listes.
///
/// Si le dossier est absent ou vide, crée **une seule fois** la liste par
/// défaut « À faire » puis la relit. Une course avec un autre écrivain se
/// résout par une relecture, jamais par un écrasement.
pub fn list_defs(
    root: &Path,
    machine_id: &str,
    at: DateTime<Utc>,
) -> Result<Vec<ReminderList>, DayaliError> {
    validate_entity_id(machine_id, "/machineId")?;
    let mut lists = Vec::new();
    for id in list_ids(&root.join(LISTS_DIR))? {
        if !is_uuid(&id) {
            continue;
        }
        lists.push(read_list(root, &id)?);
    }

    if lists.is_empty() {
        let default = default_list(machine_id, at);
        validate_list(&default)?;
        let bytes = serialize_pretty(&default)?;
        match atomic::write_vault_bytes(
            root,
            &list_rel_path(DEFAULT_LIST_ID),
            &bytes,
            Some(&Precondition::must_not_exist()),
            true,
        ) {
            Ok(_) => {}
            Err(error) if error.code == ErrorCode::PreconditionFailed => {}
            Err(error) => return Err(error),
        }
        lists = vec![read_list(root, DEFAULT_LIST_ID)?];
    }

    lists.sort_by(|left, right| {
        (left.order, left.name.clone(), left.id.clone()).cmp(&(
            right.order,
            right.name.clone(),
            right.id.clone(),
        ))
    });
    Ok(lists)
}

/// Crée ou met à jour une liste (mêmes règles que [`save`]).
pub fn list_save(
    root: &Path,
    incoming: ReminderList,
    expected: Option<&str>,
    machine_id: &str,
    at: DateTime<Utc>,
) -> Result<ReminderList, DayaliError> {
    validate_expected(expected)?;
    validate_entity_id(machine_id, "/machineId")?;

    let id = if incoming.id.is_empty() {
        Uuid::now_v7().to_string()
    } else {
        validate_entity_id(&incoming.id, "/id")?;
        incoming.id.clone()
    };

    let existing = match read_list(root, &id) {
        Ok(list) => Some(list),
        Err(error) if error.code == ErrorCode::NotFound => None,
        Err(error) => return Err(error),
    };

    let created_at = if let Some(existing) = &existing {
        existing.created_at.clone()
    } else if expected.is_some() {
        let mut candidate = incoming.clone();
        candidate.id = id.clone();
        candidate.schema_version = crate::models::common::SCHEMA_VERSION;
        candidate.machine_id = machine_id.to_string();
        candidate.updated_at = to_iso(at);
        if let Ok(bytes) = serialize_pretty(&candidate) {
            write_conflict_copy(root, LISTS_DIR, &id, &bytes, machine_id, at);
        }
        return Err(precondition_missing(&list_rel_path(&id)));
    } else {
        // Un `createdAt` fourni par l'UI n'est conservé que s'il est un instant
        // RFC 3339 valide ; sinon l'instant serveur fait foi (jamais de date
        // invalide écrite sur disque).
        parse_iso(&incoming.created_at)
            .map(to_iso)
            .unwrap_or_else(|_| to_iso(at))
    };

    let mut list = incoming;
    list.schema_version = crate::models::common::SCHEMA_VERSION;
    list.id = id.clone();
    list.created_at = created_at;
    list.updated_at = to_iso(at);
    list.machine_id = machine_id.to_string();

    validate_list(&list)?;
    let bytes = serialize_pretty(&list)?;
    let precondition = expected.map(Precondition::hash);

    match atomic::write_vault_bytes(
        root,
        &list_rel_path(&id),
        &bytes,
        precondition.as_ref(),
        true,
    ) {
        Ok(_) => read_list(root, &id),
        Err(error) if error.code == ErrorCode::PreconditionFailed => {
            write_conflict_copy(root, LISTS_DIR, &id, &bytes, machine_id, at);
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Supprime une liste **vide** en la déplaçant dans la corbeille.
///
/// Refuse (`E_PRECONDITION_FAILED`, `details.reason = "not_empty"`) tant qu'au
/// moins un rappel la référence ; rien n'est déplacé dans ce cas.
pub fn list_delete(
    root: &Path,
    id: &str,
    expected: &str,
    at: DateTime<Utc>,
) -> Result<(), DayaliError> {
    validate_entity_id(id, "/id")?;
    validate_expected(Some(expected))?;

    let rel = list_rel_path(id);
    let current = vault_fs::file_ref(root, &rel)?;
    if current.hash != expected {
        return Err(services::precondition_failed(
            "la liste a changé depuis la lecture : recharge avant de supprimer",
            &current,
        ));
    }

    for reminder_id in list_ids(&root.join(REMINDERS_DIR))? {
        if !is_uuid(&reminder_id) {
            continue;
        }
        let reminder = read_reminder(root, &reminder_id)?;
        if reminder.list_id == id {
            return Err(services::precondition_failed(
                "liste non vide : réaffecte ou archive ses rappels avant de la supprimer",
                &current,
            )
            .with_details(serde_json::json!({
                "current": current,
                "currentRevision": current.hash,
                "reason": "not_empty",
            })));
        }
    }

    let metadata = std::fs::symlink_metadata(root.join(&rel))
        .map_err(|error| DayaliError::from_io(&error, "liste introuvable"))?;
    if metadata.file_type().is_symlink() {
        return Err(DayaliError::path_escape(
            "suppression refusée sur un symlink de liste",
        ));
    }
    move_to_trash(root, &rel, TRASH_LISTS_DIR, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use crate::app_state::{AppState, LocalSlot};
    use crate::models::common::{parse_iso, AppPaths, SCHEMA_VERSION};
    use crate::models::machine::{Arch, MachineProfile, Platform};
    use crate::services::{machine, vault};
    use crate::vault::hash;

    const T0: &str = "2026-10-27T08:00:00.000Z";
    const T1: &str = "2026-10-27T09:30:00.000Z";
    const OTHER_MACHINE_ID: &str = "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c";

    fn instant(iso: &str) -> DateTime<Utc> {
        parse_iso(iso).unwrap()
    }

    fn profile() -> MachineProfile {
        MachineProfile {
            name: "MacBook de test".to_string(),
            platform: Platform::Macos,
            arch: Arch::Arm64,
            hostname: Some("macbook-test.local".to_string()),
            os_version: Some("macOS 26.0".to_string()),
            app_version: "0.1.0".to_string(),
        }
    }

    /// `AppState` réel sur un dossier temporaire (même construction que
    /// `services::vault::tests::state`), avec un `machine.json` hors vault.
    fn app_state(dir: &Path) -> AppState {
        let config_dir = dir.join("app-config");
        let local_path = config_dir.join("machine.json");
        let (local, _) = machine::load_or_init_local(&local_path, instant(T0)).unwrap();
        AppState::new(
            AppPaths {
                config_dir: config_dir.to_string_lossy().to_string(),
                data_dir: dir.join("app-data").to_string_lossy().to_string(),
                cache_dir: dir.join("app-cache").to_string_lossy().to_string(),
                log_dir: dir.join("app-log").to_string_lossy().to_string(),
            },
            local_path,
            profile(),
            "Europe/Paris".to_string(),
            LocalSlot::Ready(local),
        )
    }

    fn ctx(state: &AppState) -> (PathBuf, String) {
        state
            .with_vault(|open| Ok((open.root.clone(), open.machine_id.clone())))
            .unwrap()
    }

    /// Vault réel (créé par `services::vault::create`) + état applicatif réel.
    struct Harness {
        dir: tempfile::TempDir,
        /// État applicatif de la session, gardé vivant comme en production.
        #[allow(dead_code)]
        state: AppState,
        root: PathBuf,
        machine_id: String,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let state = app_state(dir.path());
            let parent = dir.path().join("vaults");
            std::fs::create_dir(&parent).unwrap();
            let (open, _) =
                vault::create(&state, parent.to_str().unwrap(), "Vault", instant(T0)).unwrap();
            state.replace_vault(Some(open)).unwrap();
            let (root, machine_id) = ctx(&state);
            Self {
                dir,
                state,
                root,
                machine_id,
            }
        }

        /// Redémarrage simulé : nouvelle instance d'`AppState` sur le même
        /// dossier d'état, qui réouvre le même vault.
        fn restart(&self) -> AppState {
            let state = app_state(self.dir.path());
            let (open, _) = vault::open(
                &state,
                self.root.to_str().unwrap(),
                instant("2026-10-27T10:00:00.000Z"),
            )
            .unwrap();
            state.replace_vault(Some(open)).unwrap();
            state
        }
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = match std::fs::read_dir(dir) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        names
    }

    fn files_in(root: &Path, rel: &str) -> Vec<String> {
        file_names(&root.join(rel))
    }

    fn conflict_copies(root: &Path) -> Vec<String> {
        files_in(root, REMINDERS_DIR)
            .into_iter()
            .filter(|name| name.contains(".conflict-"))
            .collect()
    }

    fn new_reminder(list_id: &str) -> Reminder {
        Reminder {
            schema_version: SCHEMA_VERSION,
            id: String::new(),
            list_id: list_id.to_string(),
            title: "Appeler le dentiste".to_string(),
            notes: None,
            status: ReminderStatus::Open,
            due_date: None,
            due_time: None,
            due_time_zone: None,
            project_id: None,
            completed_at: None,
            abandoned_at: None,
            recurrence: None,
            sort_key: None,
            created_at: String::new(),
            updated_at: String::new(),
            machine_id: String::new(),
            extra: serde_json::Map::new(),
        }
    }

    fn default_list_id(h: &Harness) -> String {
        let lists = list_defs(&h.root, &h.machine_id, instant(T0)).unwrap();
        assert_eq!(lists.len(), 1);
        lists[0].id.clone()
    }

    fn reminder_path(h: &Harness, id: &str) -> PathBuf {
        h.root.join(REMINDERS_DIR).join(format!("{id}.json"))
    }

    fn create_reminder(h: &Harness, list_id: &str, id: &str, at: DateTime<Utc>) -> Reminder {
        let mut reminder = new_reminder(list_id);
        reminder.id = id.to_string();
        save(&h.root, reminder, None, &h.machine_id, at).unwrap()
    }

    fn save_with(
        h: &Harness,
        list_id: &str,
        at: DateTime<Utc>,
        tweak: impl FnOnce(&mut Reminder),
    ) -> Reminder {
        let mut reminder = new_reminder(list_id);
        tweak(&mut reminder);
        save(&h.root, reminder, None, &h.machine_id, at).unwrap()
    }

    fn new_list(name: &str) -> ReminderList {
        ReminderList {
            schema_version: SCHEMA_VERSION,
            id: String::new(),
            name: name.to_string(),
            color: None,
            order: 0,
            archived: false,
            created_at: String::new(),
            updated_at: String::new(),
            machine_id: String::new(),
        }
    }

    // -- 1. Création, lecture, redémarrage --------------------------------

    #[test]
    fn create_writes_exactly_the_schema_keys_and_survives_a_restart() {
        let h = Harness::new();
        let list_id = default_list_id(&h);

        let mut incoming = new_reminder(&list_id);
        // `createdAt` fourni par l'UI et valide : conservé.
        incoming.created_at = "2026-10-01T07:05:00.000Z".to_string();
        let saved = save(&h.root, incoming, None, &h.machine_id, instant(T0)).unwrap();

        assert!(is_uuid(&saved.id), "un UUIDv7 minuscule doit être attribué");
        assert_eq!(saved.created_at, "2026-10-01T07:05:00.000Z");
        assert_eq!(saved.updated_at, T0);
        assert_eq!(saved.machine_id, h.machine_id);
        assert_eq!(saved.schema_version, SCHEMA_VERSION);

        let path = reminder_path(&h, &saved.id);
        assert!(path.is_file(), "reminders/{}.json doit exister", saved.id);
        let bytes = std::fs::read(&path).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let expected_keys = [
            "abandonedAt",
            "completedAt",
            "createdAt",
            "dueDate",
            "dueTime",
            "dueTimeZone",
            "id",
            "listId",
            "machineId",
            "notes",
            "projectId",
            "recurrence",
            "schemaVersion",
            "sortKey",
            "status",
            "title",
            "updatedAt",
        ];
        assert_eq!(keys, expected_keys, "clés du fichier≠schéma");
        assert_eq!(value["abandonedAt"], Value::Null);
        for key in [
            "notes",
            "dueDate",
            "dueTime",
            "dueTimeZone",
            "projectId",
            "completedAt",
            "recurrence",
            "sortKey",
        ] {
            assert_eq!(value[key], Value::Null, "{key} doit être présent et null");
        }
        assert_eq!(value["status"], "open");

        // Relecture par le service.
        assert_eq!(read_reminder(&h.root, &saved.id).unwrap(), saved);

        // Redémarrage simulé : autre `AppState`, même dossier, même contenu.
        let restarted = h.restart();
        let (root, machine_id) = ctx(&restarted);
        assert_eq!(root, h.root);
        assert_eq!(machine_id, h.machine_id);
        assert_eq!(read_reminder(&root, &saved.id).unwrap(), saved);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "un redémarrage ne doit pas réécrire un rappel"
        );
    }

    // -- 2. Mise à jour avec le bon hash ----------------------------------

    #[test]
    fn unknown_status_is_read_only_and_warned_without_rewrite() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let reminder = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &reminder.id);
        let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["status"] = serde_json::json!("future-status");
        value.as_object_mut().unwrap().remove("abandonedAt");
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let before = std::fs::read(&path).unwrap();
        let (items, warnings) = list_tolerant(&h.root).unwrap();
        assert_eq!(items[0].status, ReminderStatus::Unknown("future-status".to_string()));
        assert!(warnings.iter().any(|warning| warning.contains("non modifiable")));
        let mut incoming = items[0].clone();
        incoming.title = "ne doit pas écrire".to_string();
        let error = save(&h.root, incoming, Some(&get_file_ref(&h.root, &reminder.id).unwrap().hash), &h.machine_id, instant(T1)).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn legacy_reminder_without_abandoned_at_is_read_and_upgraded_only_on_explicit_save() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let reminder = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &reminder.id);
        let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("abandonedAt");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert_eq!(read_reminder(&h.root, &reminder.id).unwrap().abandoned_at, None);
        let before = get_file_ref(&h.root, &reminder.id).unwrap().hash;
        let mut incoming = read_reminder(&h.root, &reminder.id).unwrap();
        incoming.title = "mise à jour explicite".to_string();
        save(&h.root, incoming, Some(&before), &h.machine_id, instant(T1)).unwrap();
        let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["abandonedAt"], Value::Null);
    }

    #[test]
    fn update_with_matching_hash_keeps_created_at_and_bumps_updated_at() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let current = get_file_ref(&h.root, &created.id).unwrap();

        let mut incoming = created.clone();
        incoming.title = "Appeler le dentiste et l'ophtalmo".to_string();
        incoming.created_at = "1999-01-01T00:00:00.000Z".to_string(); // ignoré
        incoming.machine_id = OTHER_MACHINE_ID.to_string(); // imposé

        let saved = save(
            &h.root,
            incoming,
            Some(&current.hash),
            &h.machine_id,
            instant(T1),
        )
        .unwrap();

        assert_eq!(saved.id, created.id);
        assert_eq!(saved.title, "Appeler le dentiste et l'ophtalmo");
        assert_eq!(
            saved.created_at, created.created_at,
            "createdAt doit être conservé"
        );
        assert_eq!(saved.updated_at, T1);
        assert_ne!(saved.updated_at, created.updated_at);
        assert_eq!(
            saved.machine_id, h.machine_id,
            "machineId est imposé par l'écrivain"
        );
        assert_eq!(read_reminder(&h.root, &created.id).unwrap(), saved);
        assert!(conflict_copies(&h.root).is_empty());
    }

    // -- 2 bis. Récurrence V2 jamais détruite par un client V1 ------------

    #[test]
    fn update_with_null_recurrence_keeps_a_v2_recurrence_already_on_disk() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);

        // Fichier V2 écrit hors de l'app (ou par une version V2) : le reader V1
        // doit le tolérer sans le détruire.
        let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["recurrence"] = serde_json::json!({
            "frequency": "weekly",
            "interval": 2,
            "weekdays": [1, 3],
            "untilDate": null,
            "count": null,
            "timeZone": "Europe/Paris",
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let on_disk = read_reminder(&h.root, &created.id).unwrap();
        assert!(on_disk.recurrence.is_some(), "récurrence V2 non lue");
        let current = get_file_ref(&h.root, &created.id).unwrap();

        // Client V1 : il ne connaît pas le champ et renvoie `null`.
        let mut incoming = on_disk.clone();
        incoming.recurrence = None;
        incoming.title = "Titre mis à jour par V1".to_string();
        let saved = save(
            &h.root,
            incoming,
            Some(&current.hash),
            &h.machine_id,
            instant(T1),
        )
        .unwrap();

        assert_eq!(saved.title, "Titre mis à jour par V1");
        assert_eq!(
            saved.recurrence, on_disk.recurrence,
            "une récurrence V2 lue ne doit jamais être remplacée par null"
        );
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["recurrence"]["frequency"], "weekly");
        assert_eq!(written["recurrence"]["interval"], 2);
        assert_eq!(written["recurrence"]["weekdays"], serde_json::json!([1, 3]));
        assert_eq!(written["recurrence"]["timeZone"], "Europe/Paris");
        assert_eq!(
            read_reminder(&h.root, &created.id).unwrap().recurrence,
            on_disk.recurrence
        );

        // Une récurrence entrante non nulle reste refusée (jamais écrasée).
        let current = get_file_ref(&h.root, &created.id).unwrap();
        let mut incoming = read_reminder(&h.root, &created.id).unwrap();
        incoming.recurrence = Some(ReminderRecurrence {
            frequency: crate::models::reminders::RecurrenceFrequency::Daily,
            interval: 1,
            weekdays: vec![],
            until_date: None,
            count: None,
            time_zone: "Europe/Paris".to_string(),
            extra: serde_json::Map::new(),
        });
        let error = save(
            &h.root,
            incoming,
            Some(&current.hash),
            &h.machine_id,
            instant(T1),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);
        assert_eq!(error.details.unwrap()["path"], "/recurrence");
        assert_eq!(
            read_reminder(&h.root, &created.id).unwrap().recurrence,
            on_disk.recurrence,
            "un refus E_UNSUPPORTED ne doit rien modifier sur disque"
        );
    }

    // -- 3. Compatibilité forward et hash périmé ---------------------------

    #[test]
    fn unknown_top_level_and_nested_extensions_survive_save_and_restart() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let mut document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        document["futureNumber"] = serde_json::json!(42);
        document["futureArray"] = serde_json::json!(["a", {"nested": true}]);
        document["recurrence"] = serde_json::json!({
            "frequency": "weekly", "interval": 2, "weekdays": [1, 3],
            "untilDate": null, "count": null, "timeZone": "Europe/Paris",
            "futureNestedNumber": 7, "futureNestedArray": [1, 2, 3]
        });
        let original = serde_json::to_vec_pretty(&document).unwrap();
        std::fs::write(&path, &original).unwrap();

        let current = get_file_ref(&h.root, &created.id).unwrap();
        let mut incoming = read_reminder(&h.root, &created.id).unwrap();
        incoming.title = "Titre modifié".to_string();
        incoming.recurrence = None;
        save(&h.root, incoming, Some(&current.hash), &h.machine_id, instant(T1)).unwrap();

        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["futureNumber"], 42);
        assert_eq!(written["futureArray"], serde_json::json!(["a", {"nested": true}]));
        assert_eq!(written["recurrence"]["futureNestedNumber"], 7);
        assert_eq!(written["recurrence"]["futureNestedArray"], serde_json::json!([1, 2, 3]));
        assert_eq!(read_reminder(&h.root, &created.id).unwrap().title, "Titre modifié");
        assert_eq!(read_reminder(&h.root, &created.id).unwrap().recurrence.unwrap().extra["futureNestedNumber"], 7);
    }

    #[test]
    fn update_with_stale_hash_is_refused_keeps_file_and_writes_conflict_copy() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let mut enriched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        enriched["futureNumber"] = serde_json::json!(42);
        enriched["futureArray"] = serde_json::json!(["incoming", {"nestedNumber": 7, "nestedArray": [1, 2]}]);
        let before = serde_json::to_vec_pretty(&enriched).unwrap();
        std::fs::write(&path, &before).unwrap();
        let current = get_file_ref(&h.root, &created.id).unwrap();
        // Hash d'une version qui n'est plus celle du disque.
        let stale = hash::sha256_bytes(b"une version que le disque n'a plus");

        let mut incoming = created.clone();
        incoming.title = "Titre concurrent".to_string();
        let error = save(
            &h.root,
            incoming,
            Some(&stale),
            OTHER_MACHINE_ID,
            instant(T1),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        let details = error.details.clone().unwrap();
        assert_eq!(details["current"]["hash"], current.hash);
        assert_eq!(details["current"]["size"], current.size);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "fichier courant modifié à tort"
        );
        let current_reminder = read_reminder(&h.root, &created.id).unwrap();
        assert_eq!(current_reminder.extra["futureNumber"], 42);
        assert_eq!(current_reminder.extra["futureArray"], serde_json::json!(["incoming", {"nestedNumber": 7, "nestedArray": [1, 2]}]));
        assert_eq!(current_reminder.title, created.title);

        let conflicts = conflict_copies(&h.root);
        assert_eq!(conflicts.len(), 1, "une copie .conflict-* attendue");
        let copy: Value = serde_json::from_slice(
            &std::fs::read(h.root.join(REMINDERS_DIR).join(&conflicts[0])).unwrap(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(h.root.join(REMINDERS_DIR).join(&conflicts[0])).unwrap(),
            before,
            "la copie de conflit doit être une copie d'octets du rappel original"
        );
        assert_eq!(copy["title"], "Appeler le dentiste");
        assert_eq!(copy["id"], created.id.as_str());

        // Une copie de conflit n'est jamais listée comme un rappel.
        let listed = list(&h.root, None, instant(T0), 4, Tz::Europe__Paris).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
    }

    // -- 4. Écrasement sans précondition ----------------------------------

    #[test]
    fn overwriting_an_existing_reminder_without_expected_is_refused() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let before = std::fs::read(&path).unwrap();

        let mut incoming = created.clone();
        incoming.title = "Écrasement silencieux".to_string();
        let error = save(&h.root, incoming, None, &h.machine_id, instant(T1)).unwrap_err();

        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(
            error.details.clone().unwrap()["current"]["hash"],
            hash::sha256_bytes(&before)
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read_reminder(&h.root, &created.id).unwrap(), created);
        // La version refusée est conservée : rien ne disparaît en silence.
        assert_eq!(conflict_copies(&h.root).len(), 1);
    }

    // -- 5. Suppression ----------------------------------------------------

    #[test]
    fn delete_moves_to_trash_and_a_bad_hash_leaves_the_file_intact() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let before = std::fs::read(&path).unwrap();
        let current = get_file_ref(&h.root, &created.id).unwrap();

        // Mauvais hash : refus, fichier intact, liste inchangée.
        let error = delete(
            &h.root,
            &created.id,
            &hash::sha256_bytes(b"autre"),
            instant(T1),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(list(&h.root, None, instant(T0), 4, Tz::Europe__Paris)
            .unwrap()
            .iter()
            .any(|reminder| reminder.id == created.id));

        // Bon hash : déplacement (jamais une suppression sèche).
        delete(&h.root, &created.id, &current.hash, instant(T1)).unwrap();
        assert!(!path.exists());
        let trash = h
            .root
            .join(TRASH_REMINDERS_DIR)
            .join(format!("{}.json", created.id));
        assert!(
            trash.is_file(),
            "le rappel doit être dans .dayali/trash/reminders/"
        );
        assert_eq!(std::fs::read(&trash).unwrap(), before);
        assert!(list(&h.root, None, instant(T0), 4, Tz::Europe__Paris)
            .unwrap()
            .is_empty());
        assert!(list(&h.root, None, instant(T0), 4, Tz::Europe__Paris)
            .unwrap()
            .iter()
            .all(|reminder| reminder.id != created.id));

        // Deuxième suppression : plus de fichier, donc E_NOT_FOUND (jamais un
        // succès factice).
        let error = delete(&h.root, &created.id, &current.hash, instant(T1)).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    // -- 6. Filtres --------------------------------------------------------

    #[test]
    fn filters_apply_status_list_and_due_window() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let other_list = list_save(
            &h.root,
            new_list("Courses"),
            None,
            &h.machine_id,
            instant(T0),
        )
        .unwrap();

        let overdue = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.title = "En retard".to_string();
            reminder.due_date = Some("2026-10-25".to_string());
        });
        let yesterday_done = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.title = "Fait hier".to_string();
            reminder.due_date = Some("2026-10-26".to_string());
            reminder.status = ReminderStatus::Done;
            reminder.completed_at = Some("2026-10-26T12:00:00.000Z".to_string());
        });
        let today = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.title = "Aujourd'hui".to_string();
            reminder.due_date = Some("2026-10-27".to_string());
            reminder.due_time = Some("09:00".to_string());
            reminder.due_time_zone = Some("Europe/Paris".to_string());
        });
        let future = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.title = "Plus tard".to_string();
            reminder.due_date = Some("2026-10-30".to_string());
        });
        let no_date = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.title = "Un jour".to_string();
        });
        let other_list_item = save_with(&h, &other_list.id, instant(T0), |reminder| {
            reminder.title = "Course de today".to_string();
            reminder.due_date = Some("2026-10-27".to_string());
        });

        let at = instant(T0);
        let tz = Tz::Europe__Paris;

        let all = list(&h.root, None, at, 4, tz).unwrap();
        let due_dates: Vec<Option<&str>> = all.iter().map(|r| r.due_date.as_deref()).collect();
        assert_eq!(
            due_dates,
            vec![
                Some("2026-10-25"),
                Some("2026-10-26"),
                Some("2026-10-27"),
                Some("2026-10-27"),
                Some("2026-10-30"),
                None,
            ],
            "tri : échéance croissante, sans date en dernier"
        );

        // statuses
        let open_only = list(
            &h.root,
            Some(&RemindersFilter {
                statuses: Some(vec![ReminderStatus::Open]),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap();
        assert_eq!(open_only.len(), 5);
        assert!(open_only.iter().all(|r| r.status == ReminderStatus::Open));

        let done_only = list(
            &h.root,
            Some(&RemindersFilter {
                statuses: Some(vec![ReminderStatus::Done, ReminderStatus::Cancelled]),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap();
        assert_eq!(done_only.len(), 1);
        assert_eq!(done_only[0].id, yesterday_done.id);

        // dueWithinDays = 0 : retard inclus, aujourd'hui inclus, sans date exclu.
        let due_today = list(
            &h.root,
            Some(&RemindersFilter {
                statuses: Some(vec![ReminderStatus::Open]),
                due_within_days: Some(0),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap();
        let ids: Vec<&str> = due_today.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(due_today.len(), 3);
        assert!(ids.contains(&overdue.id.as_str()));
        assert!(ids.contains(&today.id.as_str()));
        assert!(ids.contains(&other_list_item.id.as_str()));
        assert!(
            !ids.contains(&no_date.id.as_str()),
            "un rappel sans date n'a pas d'échéance"
        );
        assert!(!ids.contains(&future.id.as_str()));

        // Fenêtre bornée : n = 2 -> [jour-1, jour].
        let two_days = list(
            &h.root,
            Some(&RemindersFilter {
                statuses: Some(vec![ReminderStatus::Open]),
                due_within_days: Some(2),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap();
        let ids: Vec<&str> = two_days.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(two_days.len(), 2);
        assert!(!ids.contains(&overdue.id.as_str()));
        assert!(ids.contains(&today.id.as_str()));

        // listIds
        let other_only = list(
            &h.root,
            Some(&RemindersFilter {
                list_ids: Some(vec![other_list.id.clone()]),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap();
        assert_eq!(other_only.len(), 1);
        assert_eq!(other_only[0].id, other_list_item.id);

        // dueWithinDays négatif : refus explicite, pas un filtre silencieux.
        let error = list(
            &h.root,
            Some(&RemindersFilter {
                due_within_days: Some(-1),
                ..Default::default()
            }),
            at,
            4,
            tz,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.unwrap()["path"], "/filter/dueWithinDays");
    }

    // -- 7. Validations ----------------------------------------------------

    fn assert_refused(
        h: &Harness,
        list_id: &str,
        tweak: impl FnOnce(&mut Reminder),
        code: ErrorCode,
        path: &str,
    ) {
        let mut reminder = new_reminder(list_id);
        reminder.id = Uuid::now_v7().to_string();
        tweak(&mut reminder);

        let before = files_in(&h.root, REMINDERS_DIR);
        let error = save(&h.root, reminder.clone(), None, &h.machine_id, instant(T0)).unwrap_err();

        assert_eq!(error.code, code, "code inattendu pour {path}");
        assert_eq!(error.details.clone().unwrap()["path"], path);
        assert_eq!(
            files_in(&h.root, REMINDERS_DIR),
            before,
            "un rappel invalide a été écrit malgré le refus ({path})"
        );
        assert_eq!(
            read_reminder(&h.root, &reminder.id).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn invalid_reminders_are_refused_before_any_write() {
        let h = Harness::new();
        let list_id = default_list_id(&h);

        assert_refused(
            &h,
            &list_id,
            |reminder| reminder.title = "   ".to_string(),
            ErrorCode::SchemaInvalid,
            "/title",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| reminder.notes = Some("n".repeat(MAX_NOTES_CHARS + 1)),
            ErrorCode::SchemaInvalid,
            "/notes",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| {
                reminder.due_date = Some("2026-10-30".to_string());
                reminder.due_time = Some("09:00".to_string());
                reminder.due_time_zone = None;
            },
            ErrorCode::SchemaInvalid,
            "/dueTimeZone",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| {
                reminder.status = ReminderStatus::Done;
                reminder.completed_at = None;
            },
            ErrorCode::SchemaInvalid,
            "/completedAt",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| {
                reminder.recurrence = Some(ReminderRecurrence {
                    frequency: crate::models::reminders::RecurrenceFrequency::Weekly,
                    interval: 1,
                    weekdays: vec![1],
                    until_date: None,
                    count: None,
                    time_zone: "Europe/Paris".to_string(),
                    extra: serde_json::Map::new(),
                });
            },
            ErrorCode::Unsupported,
            "/recurrence",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| reminder.list_id = "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4aff".to_string(),
            ErrorCode::SchemaInvalid,
            "/listId",
        );
        assert_refused(
            &h,
            &list_id,
            |reminder| reminder.project_id = Some("refonte--site--3fa9c2d1".to_string()),
            ErrorCode::SchemaInvalid,
            "/projectId",
        );

        // Aucun fichier de rappel n'a été créé par ces tentatives : seul le
        // sous-dossier `lists/` existe dans `reminders/`.
        assert_eq!(files_in(&h.root, REMINDERS_DIR), vec!["lists".to_string()]);
    }

    #[test]
    fn project_id_must_match_the_schema_pattern() {
        let h = Harness::new();
        let list_id = default_list_id(&h);

        // Forme valide : acceptée et persistée telle quelle.
        let saved = save_with(&h, &list_id, instant(T0), |reminder| {
            reminder.project_id = Some("refonte-site--3fa9c2d1".to_string());
        });
        assert_eq!(saved.project_id.as_deref(), Some("refonte-site--3fa9c2d1"));
        assert_eq!(
            read_reminder(&h.root, &saved.id)
                .unwrap()
                .project_id
                .as_deref(),
            Some("refonte-site--3fa9c2d1")
        );

        // Formes invalides : refus avant écriture, sans laisser de fichier.
        for bad in [
            "",
            "refonte-site",
            "refonte--site--3fa9c2d1",
            "refonte---3fa9c2d1",
            "-refonte-site--3fa9c2d1",
            "refonte-site--3FA9C2D1",
            "refonte-site--3fa9c2d",
            "refonte_site--3fa9c2d1",
        ] {
            let mut reminder = new_reminder(&list_id);
            reminder.id = Uuid::now_v7().to_string();
            reminder.project_id = Some(bad.to_string());
            let before = files_in(&h.root, REMINDERS_DIR);

            let error =
                save(&h.root, reminder.clone(), None, &h.machine_id, instant(T0)).unwrap_err();

            assert_eq!(
                error.code,
                ErrorCode::SchemaInvalid,
                "projectId accepté à tort : {bad:?}"
            );
            assert_eq!(error.details.clone().unwrap()["path"], "/projectId");
            assert_eq!(
                files_in(&h.root, REMINDERS_DIR),
                before,
                "un projectId invalide a été écrit : {bad:?}"
            );
            assert_eq!(
                read_reminder(&h.root, &reminder.id).unwrap_err().code,
                ErrorCode::NotFound
            );
        }
    }

    // -- 8. Listes ---------------------------------------------------------

    #[test]
    fn default_list_is_created_once_and_only_an_empty_list_goes_to_trash() {
        let h = Harness::new();
        let at = instant(T0);

        let first = list_defs(&h.root, &h.machine_id, at).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, DEFAULT_LIST_ID);
        assert_eq!(first[0].name, DEFAULT_LIST_NAME);
        let list_path = h
            .root
            .join(LISTS_DIR)
            .join(format!("{DEFAULT_LIST_ID}.json"));
        let bytes = std::fs::read(&list_path).unwrap();
        assert_eq!(
            files_in(&h.root, LISTS_DIR),
            vec![format!("{DEFAULT_LIST_ID}.json")]
        );

        // Deuxième exploration (autre horloge, autre machine) : aucun doublon,
        // aucun écrasement.
        let second = list_defs(&h.root, OTHER_MACHINE_ID, instant(T1)).unwrap();
        assert_eq!(second, first);
        assert_eq!(std::fs::read(&list_path).unwrap(), bytes);
        assert_eq!(files_in(&h.root, LISTS_DIR).len(), 1);

        // Liste non vide : suppression refusée, rien ne bouge.
        let reminder = create_reminder(&h, DEFAULT_LIST_ID, "", at);
        let current = vault_fs::file_ref(&h.root, &list_rel_path(DEFAULT_LIST_ID)).unwrap();
        let error = list_delete(&h.root, DEFAULT_LIST_ID, &current.hash, at).unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        let details = error.details.clone().unwrap();
        assert_eq!(details["reason"], "not_empty");
        assert_eq!(details["current"]["hash"], current.hash);
        assert!(list_path.is_file());
        assert_eq!(std::fs::read(&list_path).unwrap(), bytes);
        assert_eq!(read_reminder(&h.root, &reminder.id).unwrap(), reminder);

        // Liste vide : déplacement en corbeille.
        let empty = list_save(&h.root, new_list("Vide"), None, &h.machine_id, at).unwrap();
        let empty_ref = vault_fs::file_ref(&h.root, &list_rel_path(&empty.id)).unwrap();
        list_delete(&h.root, &empty.id, &empty_ref.hash, at).unwrap();
        assert!(!h
            .root
            .join(LISTS_DIR)
            .join(format!("{}.json", empty.id))
            .exists());
        assert!(h
            .root
            .join(TRASH_LISTS_DIR)
            .join(format!("{}.json", empty.id))
            .is_file());
        let remaining = list_defs(&h.root, &h.machine_id, at).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, DEFAULT_LIST_ID);
    }

    // -- 9. FileRef --------------------------------------------------------

    #[test]
    fn get_file_ref_recomputes_hash_and_reports_not_found() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let bytes = std::fs::read(&path).unwrap();

        let reference = get_file_ref(&h.root, &created.id).unwrap();
        assert_eq!(reference.rel_path, reminder_rel_path(&created.id));
        assert_eq!(reference.hash, hash::sha256_bytes(&bytes));
        assert_eq!(reference.size, bytes.len() as u64);
        assert!(reference.mtime.ends_with('Z'));

        // Modification hors app : le hash est recalculé, jamais un cache.
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["title"] = Value::String("Modifié hors app".to_string());
        let edited = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(&path, &edited).unwrap();
        let after = get_file_ref(&h.root, &created.id).unwrap();
        assert_ne!(after.hash, reference.hash);
        assert_eq!(after.hash, hash::sha256_bytes(&edited));

        let missing = Uuid::now_v7().to_string();
        assert_eq!(
            get_file_ref(&h.root, &missing).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    // -- 9 bis. `id` interne ≠ nom de fichier ------------------------------

    #[test]
    fn read_reminder_refuses_an_internal_id_that_differs_from_the_file_name() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let created = create_reminder(&h, &list_id, "", instant(T0));
        let path = reminder_path(&h, &created.id);
        let other_id = Uuid::now_v7().to_string();

        let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["id"] = Value::String(other_id.clone());
        let tampered = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(&path, &tampered).unwrap();

        let error = read_reminder(&h.root, &created.id).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/id");
        assert!(
            error.message.contains(&format!("{}.json", created.id)),
            "le message doit nommer le fichier fautif : {}",
            error.message
        );

        // Pas de rappel fantôme : `list` refuse le fichier (elle ne le publie
        // ni sous son nom, ni sous son id interne).
        let error = list(&h.root, None, instant(T0), 4, Tz::Europe__Paris).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/id");

        // Lecture sous l'id interne : fichier absent, pas un fantôme.
        assert_eq!(
            read_reminder(&h.root, &other_id).unwrap_err().code,
            ErrorCode::NotFound
        );

        // Le fichier est laissé tel quel (aucune « réparation » silencieuse).
        assert_eq!(std::fs::read(&path).unwrap(), tampered);
    }

    #[test]
    fn read_list_refuses_an_internal_id_that_differs_from_the_file_name() {
        let h = Harness::new();
        let at = instant(T0);
        let list = list_save(&h.root, new_list("Perso"), None, &h.machine_id, at).unwrap();
        let list_path = h.root.join(LISTS_DIR).join(format!("{}.json", list.id));
        let other_id = Uuid::now_v7().to_string();

        let mut value: Value = serde_json::from_slice(&std::fs::read(&list_path).unwrap()).unwrap();
        value["id"] = Value::String(other_id.clone());
        std::fs::write(&list_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

        let error = read_list(&h.root, &list.id).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/id");
        assert!(
            error.message.contains(&format!("{}.json", list.id)),
            "le message doit nommer le fichier fautif : {}",
            error.message
        );

        // `list_defs` refuse la liste fantôme au lieu de la publier.
        let error = list_defs(&h.root, &h.machine_id, at).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/id");
    }

    // -- 10. Sécurité des chemins -----------------------------------------

    #[test]
    fn identifiers_that_escape_the_vault_are_refused() {
        let h = Harness::new();
        let list_id = default_list_id(&h);
        let outside = h.dir.path().join("hors-vault.json");
        std::fs::write(&outside, b"temoin").unwrap();

        for id in [
            "../hors-vault",
            "..",
            ".",
            "reminders/../../hors-vault",
            "a/b",
            "0199A1B2-3C4D-7E5F-8A9B-0C1D2E3F4A5B",
        ] {
            let mut reminder = new_reminder(&list_id);
            reminder.id = id.to_string();
            let error = save(&h.root, reminder, None, &h.machine_id, instant(T0)).unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::SchemaInvalid,
                "id accepté à tort : {id:?}"
            );
            assert_eq!(error.details.clone().unwrap()["path"], "/id");

            assert_eq!(
                get_file_ref(&h.root, id).unwrap_err().code,
                ErrorCode::SchemaInvalid
            );
            assert_eq!(
                read_reminder(&h.root, id).unwrap_err().code,
                ErrorCode::SchemaInvalid
            );
            assert_eq!(
                delete(&h.root, id, &"a".repeat(64), instant(T0))
                    .unwrap_err()
                    .code,
                ErrorCode::SchemaInvalid
            );
        }

        // Un identifiant vide n'est pas un chemin : lectures et suppression
        // refusent, seule la création (qui attribue un UUID) l'accepte.
        assert_eq!(
            get_file_ref(&h.root, "").unwrap_err().code,
            ErrorCode::SchemaInvalid
        );
        assert_eq!(
            read_reminder(&h.root, "").unwrap_err().code,
            ErrorCode::SchemaInvalid
        );
        assert_eq!(
            delete(&h.root, "", &"a".repeat(64), instant(T0))
                .unwrap_err()
                .code,
            ErrorCode::SchemaInvalid
        );

        assert_eq!(std::fs::read(&outside).unwrap(), b"temoin");
        assert!(
            files_in(&h.root, REMINDERS_DIR)
                .iter()
                .all(|name| !name.ends_with(".json")),
            "un rappel a été écrit malgré le refus d'identifiant"
        );
        assert!(!h.root.join("hors-vault.json").exists());
        assert!(h.root.join(REMINDERS_DIR).is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn writing_or_deleting_through_a_symlink_in_reminders_is_refused() {
        use std::os::unix::fs::symlink;

        let h = Harness::new();
        let list_id = default_list_id(&h);
        // Crée `reminders/` avec un rappel réel.
        let created = create_reminder(&h, &list_id, "", instant(T0));

        let outside = h.dir.path().join("cible-externe.json");
        std::fs::write(&outside, b"contenu externe").unwrap();

        let symlinked_id = Uuid::now_v7().to_string();
        let link = reminder_path(&h, &symlinked_id);
        symlink(&outside, &link).unwrap();

        let mut reminder = new_reminder(&list_id);
        reminder.id = symlinked_id.clone();
        reminder.title = "Écriture à travers un lien".to_string();
        let error = save(&h.root, reminder, None, &h.machine_id, instant(T0)).unwrap_err();

        assert_eq!(error.code, ErrorCode::PathEscape);
        assert_eq!(std::fs::read(&outside).unwrap(), b"contenu externe");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        // Le symlink n'est jamais listé comme un rappel.
        let listed = list(&h.root, None, instant(T0), 4, Tz::Europe__Paris).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let error = delete(
            &h.root,
            &symlinked_id,
            &hash::sha256_bytes(b"peu importe"),
            instant(T1),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::PathEscape);
        assert_eq!(std::fs::read(&outside).unwrap(), b"contenu externe");
    }
}

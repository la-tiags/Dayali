//! Identité de la machine et état local du vault (PLAN §4.2, §4.10, §5.10).
//!
//! Deux fichiers, deux rôles :
//!  - `machine.json` **hors vault** : autorité de `machineId`, `lastVaultPath`,
//!    `recentVaults` ; jamais synchronisé ;
//!  - `.dayali/machines/<machineId>.json` **dans le vault** : journal de la
//!    machine et `localState` (journée logique, reports), avec le même
//!    `machineId`.
//!
//! Toutes les écritures passent par [`crate::vault::atomic`] et une précondition
//! explicite. Aucun fichier existant n'est remplacé sans hash attendu.

use std::path::Path;
#[cfg(test)]
use std::cell::RefCell;
#[cfg(test)]
use std::thread_local;

use chrono::{DateTime, Days, NaiveDate, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{is_local_date, is_uuid, to_iso, FileRef, Precondition};
use crate::models::config::is_revision;
use crate::models::day::DayState;
use crate::models::machine::{
    CarryOverAction, LocalState, MachineFile, MachineProfile, ReminderHistoryEntry,
    ReminderHistoryStatus,
};
use crate::models::machine_local::MachineLocal;
use crate::models::reminders::{Reminder, ReminderStatus};
use crate::services::{self, day};
use crate::vault::{atomic, fs as vault_fs, hash, paths};

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum TestFailpoint {
    AfterPendingWrite,
    AfterReminderWrite,
}

#[cfg(test)]
thread_local! {
    static TEST_FAILPOINT: RefCell<Option<TestFailpoint>> = const { RefCell::new(None) };
}

#[cfg(test)]
fn set_test_failpoint(point: Option<TestFailpoint>) {
    TEST_FAILPOINT.with(|slot| *slot.borrow_mut() = point);
}

#[cfg(test)]
fn test_failpoint(point: TestFailpoint) -> Result<(), DayaliError> {
    TEST_FAILPOINT.with(|slot| {
        if *slot.borrow() == Some(point) {
            *slot.borrow_mut() = None;
            Err(DayaliError::internal("test failpoint: simulated crash"))
        } else {
            Ok(())
        }
    })
}

/// Plafond de lecture de `machine.json` hors vault.
pub const MAX_LOCAL_BYTES: usize = 128 * 1024;
/// Plafond de lecture du fichier machine du vault (transfers + reports).
pub const MAX_MACHINE_BYTES: usize = 8 * 1024 * 1024;

fn absolute_ref(path: &Path, bytes: &[u8]) -> Result<FileRef, DayaliError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées de machine.json illisibles"))?;
    Ok(FileRef {
        rel_path: paths::normalize_absolute_display(path),
        hash: hash::sha256_bytes(bytes),
        size: bytes.len() as u64,
        mtime: vault_fs::mtime_iso(&metadata)?,
    })
}

fn vault_ref(resolved: &paths::ResolvedPath, bytes: &[u8]) -> Result<FileRef, DayaliError> {
    let metadata = std::fs::metadata(&resolved.absolute).map_err(|error| {
        DayaliError::from_io(&error, "métadonnées du fichier machine illisibles")
    })?;
    Ok(FileRef {
        rel_path: resolved.rel_path.clone(),
        hash: hash::sha256_bytes(bytes),
        size: bytes.len() as u64,
        mtime: vault_fs::mtime_iso(&metadata)?,
    })
}

// ---------------------------------------------------------------------------
// machine.json hors vault
// ---------------------------------------------------------------------------

/// Lit et valide `machine.json`. Une corruption est remontée telle quelle.
pub fn read_local(path: &Path) -> Result<(MachineLocal, FileRef), DayaliError> {
    let bytes = vault_fs::read_bytes_limited(path, MAX_LOCAL_BYTES)?;
    let text = vault_fs::decode_utf8(&bytes, "machine.json")?;
    let local: MachineLocal = services::parse_json(&text, "machine.json")?;
    local.validate()?;
    let file_ref = absolute_ref(path, &bytes)?;
    Ok((local, file_ref))
}

/// Charge `machine.json`, ou le crée avec un nouvel UUIDv7 au premier lancement.
///
/// Le second membre indique si le fichier vient d'être créé. Une course avec un
/// autre processus provoque une relecture, jamais un écrasement.
pub fn load_or_init_local(
    path: &Path,
    now: DateTime<Utc>,
) -> Result<(MachineLocal, bool), DayaliError> {
    match read_local(path) {
        Ok((local, _)) => Ok((local, false)),
        Err(error) if error.code == ErrorCode::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| DayaliError::path_escape("machine.json sans dossier parent"))?;
            paths::ensure_dir(parent)?;

            let local = MachineLocal::new(Uuid::now_v7().to_string(), to_iso(now));
            local.validate()?;
            let bytes = local.to_json_bytes()?;
            match atomic::write_absolute_bytes(path, &bytes, Some(&Precondition::must_not_exist()))
            {
                Ok(_) => Ok((local, true)),
                Err(write_error) if write_error.code == ErrorCode::PreconditionFailed => {
                    read_local(path).map(|(existing, _)| (existing, false))
                }
                Err(write_error) => Err(write_error),
            }
        }
        Err(error) => Err(error),
    }
}

/// Écrit `machine.json` avec précondition explicite.
pub fn write_local(
    path: &Path,
    local: &MachineLocal,
    expected: &Precondition,
) -> Result<FileRef, DayaliError> {
    local.validate()?;
    let bytes = local.to_json_bytes()?;
    atomic::write_absolute_bytes(path, &bytes, Some(expected))
}

/// Mémorise une ouverture réussie : `lastVaultPath` et tête de `recentVaults`.
///
/// L'identité attendue est vérifiée avant écriture : si le fichier a été
/// remplacé par celui d'une autre machine, on refuse plutôt que de changer
/// silencieusement l'identité de l'installation.
pub fn remember_vault(
    path: &Path,
    absolute_path: &str,
    expected_machine_id: &str,
) -> Result<MachineLocal, DayaliError> {
    let (current, current_ref) = read_local(path)?;
    if current.machine_id != expected_machine_id {
        return Err(DayaliError::schema_invalid(
            "/machineId",
            "machine.json ne porte plus l'identité de cette installation",
        ));
    }
    let next = current.with_vault_opened(absolute_path);
    next.validate()?;
    write_local(path, &next, &Precondition::hash(current_ref.hash))?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// Fichier machine dans le vault
// ---------------------------------------------------------------------------

/// Chemin relatif du fichier machine, validé avant composition.
pub fn machine_rel_path(machine_id: &str) -> Result<String, DayaliError> {
    if !is_uuid(machine_id) {
        return Err(DayaliError::schema_invalid(
            "/machineId",
            "machineId : UUID minuscule attendu",
        ));
    }
    Ok(format!(".dayali/machines/{machine_id}.json"))
}

/// Lit le fichier machine du vault et vérifie que son identifiant correspond au
/// nom de fichier.
pub fn read_vault_machine(
    root: &Path,
    machine_id: &str,
) -> Result<(MachineFile, FileRef), DayaliError> {
    let rel = machine_rel_path(machine_id)?;
    let resolved = paths::resolve_read(root, &rel)?;
    let bytes = vault_fs::read_bytes_limited(&resolved.absolute, MAX_MACHINE_BYTES)?;
    let text = vault_fs::decode_utf8(&bytes, &rel)?;
    let machine: MachineFile = services::parse_json(&text, &rel)?;
    machine.validate(machine_id)?;
    let file_ref = vault_ref(&resolved, &bytes)?;
    Ok((machine, file_ref))
}

/// Crée le fichier machine du vault avec `mustNotExist`.
pub fn create_vault_machine(
    root: &Path,
    machine_id: &str,
    profile: &MachineProfile,
    at: DateTime<Utc>,
    vault_root: &str,
) -> Result<(MachineFile, FileRef), DayaliError> {
    let stamp = to_iso(at);
    let machine = MachineFile::new(machine_id, &stamp, &stamp, vault_root, profile);
    machine.validate(machine_id)?;
    let rel = machine_rel_path(machine_id)?;
    let bytes = machine.to_json_bytes()?;
    let written = atomic::write_vault_bytes(
        root,
        &rel,
        &bytes,
        Some(&Precondition::must_not_exist()),
        true,
    )?;
    Ok((machine, written))
}

/// Lit le fichier machine du vault, ou le crée s'il est absent.
///
/// Un fichier existant n'est jamais réécrit à l'ouverture : il peut contenir des
/// transferts et un état local que l'app n'a pas encore lus.
pub fn load_or_create_vault_machine(
    root: &Path,
    machine_id: &str,
    profile: &MachineProfile,
    at: DateTime<Utc>,
    vault_root: &str,
) -> Result<(MachineFile, String), DayaliError> {
    match read_vault_machine(root, machine_id) {
        Ok((_machine, _file_ref)) => {
            let (machine, hash) = reconcile_pending(root, machine_id, at)?;
            Ok((machine, hash))
        }
        Err(error) if error.code == ErrorCode::NotFound => {
            match create_vault_machine(root, machine_id, profile, at, vault_root) {
                Ok((machine, file_ref)) => Ok((machine, file_ref.hash)),
                Err(create_error) if create_error.code == ErrorCode::PreconditionFailed => {
                    let (machine, file_ref) = read_vault_machine(root, machine_id)?;
                    Ok((machine, file_ref.hash))
                }
                Err(create_error) => Err(create_error),
            }
        }
        Err(error) => Err(error),
    }
}

/// Patch de `localState` avec précondition stricte sur le fichier machine.
pub fn patch_local_state(
    root: &Path,
    machine_id: &str,
    patch: &Value,
    expected_revision: &str,
) -> Result<(LocalState, String), DayaliError> {
    if !is_revision(expected_revision) {
        return Err(DayaliError::schema_invalid(
            "/expectedRevision",
            "expectedRevision : SHA-256 hexadécimal minuscule attendu",
        ));
    }
    if !patch.is_object() {
        return Err(DayaliError::schema_invalid(
            "/patch",
            "le patch de localState doit être un objet JSON",
        ));
    }

    let (machine, file_ref) = read_vault_machine(root, machine_id)?;
    if file_ref.hash != expected_revision {
        return Err(services::precondition_failed(
            "le fichier machine a changé depuis la lecture : recharge l'état local",
            &file_ref,
        ));
    }

    let mut merged = serde_json::to_value(&machine.local_state)?;
    services::deep_merge(&mut merged, patch);
    let local_state: LocalState = services::parse_json_value(merged, "localState")?;

    if local_state == machine.local_state {
        return Ok((local_state, file_ref.hash));
    }

    let mut next = machine;
    next.local_state = local_state.clone();
    next.validate(machine_id)?;
    let rel = machine_rel_path(machine_id)?;
    let bytes = next.to_json_bytes()?;
    let written = atomic::write_vault_bytes(
        root,
        &rel,
        &bytes,
        Some(&Precondition::hash(expected_revision)),
        false,
    )?;
    Ok((local_state, written.hash))
}

/// Rejoue les intentions pending. Si la cible est déjà atteinte, seule
/// l'intention est marquée applied ; sinon l'action est appliquée avec la
/// précondition capturée dans l'entrée (le hash est relu, jamais deviné).
pub fn reconcile_pending(
    root: &Path,
    machine_id: &str,
    at: DateTime<Utc>,
) -> Result<(MachineFile, String), DayaliError> {
    let (mut machine, _) = read_vault_machine(root, machine_id)?;
    let pending: Vec<ReminderHistoryEntry> = machine
        .local_state
        .reminder_history
        .iter()
        .filter(|entry| entry.status == ReminderHistoryStatus::Pending)
        .cloned()
        .collect();
    for entry in pending {
        let Ok(current) = crate::services::reminders::read_reminder(root, &entry.reminder_id)
        else {
            continue;
        };
        let target_reached = match entry.action {
            CarryOverAction::Tomorrow | CarryOverAction::Replan => {
                current.due_date == entry.new_due_date
            }
            CarryOverAction::Abandon => current.status == ReminderStatus::Abandoned,
            CarryOverAction::Restore => current.status == ReminderStatus::Open,
        };
        if !target_reached {
            if let Some(expected) = entry.expected_hash.as_deref() {
                let next = match entry.action {
                    CarryOverAction::Tomorrow | CarryOverAction::Replan => {
                        let mut value = current.clone();
                        value.due_date = entry.new_due_date.clone();
                        value
                    }
                    CarryOverAction::Abandon => {
                        let mut value = current.clone();
                        value.status = ReminderStatus::Abandoned;
                        value.abandoned_at = Some(to_iso(at));
                        value
                    }
                    CarryOverAction::Restore => {
                        let mut value = current.clone();
                        value.status = ReminderStatus::Open;
                        value.abandoned_at = None;
                        value
                    }
                };
                if crate::services::reminders::save(root, next, Some(expected), machine_id, at)
                    .is_err()
                {
                    continue;
                }
            } else {
                continue;
            }
        }
        if let Some(item) = machine
            .local_state
            .reminder_history
            .iter_mut()
            .find(|item| item.id == entry.id)
        {
            item.status = ReminderHistoryStatus::Applied;
            item.resolved_at = Some(to_iso(at));
        }
    }
    machine.validate(machine_id)?;
    let rel = machine_rel_path(machine_id)?;
    let bytes = machine.to_json_bytes()?;
    let current = read_vault_machine(root, machine_id)?.1;
    let written = atomic::write_vault_bytes(
        root,
        &rel,
        &bytes,
        Some(&Precondition::hash(current.hash)),
        false,
    )?;
    Ok((machine, written.hash))
}

// ---------------------------------------------------------------------------
// Journée logique (PLAN §5.10)
// ---------------------------------------------------------------------------

fn day_state_from(
    root: &Path,
    local: &LocalState,
    day_start_hour: u32,
    time_zone: Tz,
    at: DateTime<Utc>,
) -> Result<DayState, DayaliError> {
    let logical_day = day::logical_day_string(at, day_start_hour, time_zone)?;
    let (candidates, warnings) = carry_over_candidates(root, local, &logical_day)?;
    Ok(DayState {
        started: local.last_day_start_date.as_deref() == Some(logical_day.as_str()),
        logical_day,
        day_start_hour,
        last_day_started_at: local.last_day_started_at.clone(),
        late_night_shown_for: local.late_night_shown_for.clone(),
        carry_over_candidates: candidates,
        carry_over_warnings: warnings,
    })
}

/// Restes non traités pour la veille logique (PLAN §4.2, SPEC §6).
///
/// Un rappel est reproposé quand il est **ouvert**, a une `dueDate` non nulle
/// ≤ la veille et qu'aucune entrée `reminderHistory` ne porte déjà son
/// `reminderId` pour cette même `sourceDay`. Le tri est celui de
/// [`services::reminders::list`] : la sélection ne réordonne rien.
///
/// La lecture est **tolérante par fichier** : un rappel illisible est ignoré et
/// signalé dans les avertissements, sans jamais être réécrit ni supprimé. Une
/// erreur d'accès au dossier `reminders/` reste une erreur : sans énumération
/// fiable, on ne peut pas prétendre avoir calculé les restes.
fn carry_over_candidates(
    root: &Path,
    local: &LocalState,
    logical_day: &str,
) -> Result<(Vec<Reminder>, Vec<String>), DayaliError> {
    let today = NaiveDate::parse_from_str(logical_day, "%Y-%m-%d").map_err(|_| {
        DayaliError::internal("journée logique illisible pour le calcul des reports")
    })?;
    let source_day = today
        .checked_sub_days(Days::new(1))
        .ok_or_else(|| DayaliError::internal("veille hors bornes calendaires"))?
        .format("%Y-%m-%d")
        .to_string();

    let (reminders, warnings) = services::reminders::list_tolerant(root)?;
    let candidates = reminders
        .into_iter()
        .filter(|reminder| reminder.status == ReminderStatus::Open)
        .filter(|reminder| {
            reminder
                .due_date
                .as_deref()
                .is_some_and(|due_date| due_date <= source_day.as_str())
        })
        .filter(|reminder| {
            !local
                .reminder_history
                .iter()
                .any(|entry| entry.reminder_id == reminder.id && entry.source_day == source_day)
        })
        .collect();
    Ok((candidates, warnings))
}

/// État de journée courant, calculé depuis le fichier machine du vault.
/// Enregistre et applique une décision de fin de journée avec journal d'intention.
/// Chaque clé est idempotente (rappel + action + journée logique).
pub fn apply_reminder_action(
    root: &Path,
    machine_id: &str,
    reminder_id: &str,
    action: CarryOverAction,
    new_due_date: Option<&str>,
    expected_hash: &str,
    source_day: &str,
    logical_day: &str,
    at: DateTime<Utc>,
) -> Result<Reminder, DayaliError> {
    if !is_uuid(reminder_id) || !is_local_date(source_day) || !is_local_date(logical_day) {
        return Err(DayaliError::schema_invalid(
            "/reminderId",
            "identifiant et jours invalides",
        ));
    }
    let (mut machine, machine_ref) = read_vault_machine(root, machine_id)?;
    let existing_id = machine
        .local_state
        .reminder_history
        .iter()
        .find(|entry| {
            entry.reminder_id == reminder_id
                && entry.action == action
                && entry.logical_day == logical_day
        })
        .map(|entry| (entry.id.clone(), entry.status));
    if let Some((_, ReminderHistoryStatus::Applied)) = existing_id {
        return crate::services::reminders::read_reminder(root, reminder_id);
    }
    let reminder = crate::services::reminders::read_reminder(root, reminder_id)?;
    let entry = ReminderHistoryEntry {
        id: existing_id
            .as_ref()
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| Uuid::now_v7().to_string()),
        reminder_id: reminder_id.to_string(),
        action,
        status: ReminderHistoryStatus::Pending,
        source_day: source_day.to_string(),
        logical_day: logical_day.to_string(),
        due_date: reminder.due_date.clone(),
        new_due_date: new_due_date.map(str::to_string),
        expected_hash: Some(expected_hash.to_string()),
        created_at: to_iso(at),
        resolved_at: None,
    };
    if existing_id.is_none() {
        machine.local_state.reminder_history.push(entry.clone());
    }
    machine.validate(machine_id)?;
    let rel = machine_rel_path(machine_id)?;
    atomic::write_vault_bytes(
        root,
        &rel,
        &machine.to_json_bytes()?,
        Some(&Precondition::hash(machine_ref.hash)),
        false,
    )?;
    #[cfg(test)]
    test_failpoint(TestFailpoint::AfterPendingWrite)?;

    let mut next = reminder.clone();
    match action {
        CarryOverAction::Tomorrow | CarryOverAction::Replan => {
            next.due_date = new_due_date.map(str::to_string)
        }
        CarryOverAction::Abandon => {
            next.status = ReminderStatus::Abandoned;
            next.abandoned_at = Some(to_iso(at));
        }
        CarryOverAction::Restore => {
            next.status = ReminderStatus::Open;
            next.abandoned_at = None;
        }
    }
    let updated =
        crate::services::reminders::save(root, next, Some(expected_hash), machine_id, at)?;
    #[cfg(test)]
    test_failpoint(TestFailpoint::AfterReminderWrite)?;
    let (mut machine, current_ref) = read_vault_machine(root, machine_id)?;
    if let Some(item) = machine
        .local_state
        .reminder_history
        .iter_mut()
        .find(|item| item.id == entry.id)
    {
        item.status = ReminderHistoryStatus::Applied;
        item.resolved_at = Some(to_iso(at));
    }
    machine.validate(machine_id)?;
    atomic::write_vault_bytes(
        root,
        &rel,
        &machine.to_json_bytes()?,
        Some(&Precondition::hash(current_ref.hash)),
        false,
    )?;
    Ok(updated)
}

pub fn day_state(
    root: &Path,
    machine_id: &str,
    day_start_hour: u32,
    time_zone: Tz,
    at: DateTime<Utc>,
) -> Result<DayState, DayaliError> {
    let (machine, _) = read_vault_machine(root, machine_id)?;
    day_state_from(root, &machine.local_state, day_start_hour, time_zone, at)
}

/// Démarre la journée logique de `at`, sans effet si elle est déjà démarrée.
pub fn day_start(
    root: &Path,
    machine_id: &str,
    day_start_hour: u32,
    time_zone: Tz,
    at: DateTime<Utc>,
) -> Result<DayState, DayaliError> {
    let (machine, file_ref) = read_vault_machine(root, machine_id)?;
    let logical_day = day::logical_day_string(at, day_start_hour, time_zone)?;

    let mut next = machine;
    // Lire les restes **avant** toute écriture : un rappel illisible doit
    // échouer sans laisser la journée marquée comme démarrée.
    let mut state = day_state_from(root, &next.local_state, day_start_hour, time_zone, at)?;
    if next.local_state.last_day_start_date.as_deref() != Some(logical_day.as_str()) {
        next.local_state.last_day_start_date = Some(logical_day.clone());
        next.local_state.last_day_started_at = Some(to_iso(at));
        next.validate(machine_id)?;
        let rel = machine_rel_path(machine_id)?;
        let bytes = next.to_json_bytes()?;
        atomic::write_vault_bytes(
            root,
            &rel,
            &bytes,
            Some(&Precondition::hash(file_ref.hash)),
            false,
        )?;
        state.started = true;
        state.last_day_started_at = next.local_state.last_day_started_at.clone();
    }

    Ok(state)
}

/// Marque le message « il est tard » comme affiché pour la journée logique de
/// `at`. Idempotent : une seule écriture par journée.
pub fn mark_late_night_shown(
    root: &Path,
    machine_id: &str,
    day_start_hour: u32,
    time_zone: Tz,
    at: DateTime<Utc>,
) -> Result<DayState, DayaliError> {
    let (machine, file_ref) = read_vault_machine(root, machine_id)?;
    let logical_day = day::logical_day_string(at, day_start_hour, time_zone)?;

    let mut next = machine;
    // Même ordre que `day_start` : lecture des restes avant l'écriture.
    let mut state = day_state_from(root, &next.local_state, day_start_hour, time_zone, at)?;
    if next.local_state.late_night_shown_for.as_deref() != Some(logical_day.as_str()) {
        next.local_state.late_night_shown_for = Some(logical_day);
        next.validate(machine_id)?;
        let rel = machine_rel_path(machine_id)?;
        let bytes = next.to_json_bytes()?;
        atomic::write_vault_bytes(
            root,
            &rel,
            &bytes,
            Some(&Precondition::hash(file_ref.hash)),
            false,
        )?;
        state.late_night_shown_for = next.local_state.late_night_shown_for.clone();
    }

    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::{parse_iso, to_iso, SCHEMA_VERSION};
    use crate::models::machine::{Arch, Platform};
    use crate::models::reminders::{Reminder, ReminderStatus};

    const MACHINE_ID: &str = "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";

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

    fn at(value: &str) -> DateTime<Utc> {
        parse_iso(value).unwrap()
    }

    fn vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    fn local_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("machine.json");
        (dir, path)
    }

    #[test]
    fn local_identity_is_created_once_and_reused() {
        let (_dir, path) = local_file();
        let (first, created) = load_or_init_local(&path, at("2026-10-27T08:00:00.000Z")).unwrap();
        assert!(created);
        assert!(is_uuid(&first.machine_id));
        assert_eq!(first.last_vault_path, None);
        assert!(first.recent_vaults.is_empty());

        let (second, created_again) =
            load_or_init_local(&path, at("2026-10-28T08:00:00.000Z")).unwrap();
        assert!(!created_again);
        assert_eq!(second, first);
    }

    #[test]
    fn remembering_vaults_caps_at_ten_and_keeps_one_machine_id() {
        let (_dir, path) = local_file();
        let (mut local, _) = load_or_init_local(&path, at("2026-10-27T08:00:00.000Z")).unwrap();
        for index in 0..12 {
            local =
                remember_vault(&path, &format!("/tmp/vault-{index}"), &local.machine_id).unwrap();
        }
        assert_eq!(local.recent_vaults.len(), 10);
        assert_eq!(local.recent_vaults[0], "/tmp/vault-11");
        assert_eq!(local.last_vault_path.as_deref(), Some("/tmp/vault-11"));
        assert_eq!(local.machine_id, machine_id_from_file(&path));
        local.validate().unwrap();
    }

    fn machine_id_from_file(path: &Path) -> String {
        read_local(path).unwrap().0.machine_id
    }

    #[test]
    fn machine_file_in_vault_is_never_overwritten() {
        let (_dir, root) = vault();
        let (created, _) = create_vault_machine(
            &root,
            MACHINE_ID,
            &profile(),
            at("2026-10-27T08:00:00.000Z"),
            "/tmp/vault",
        )
        .unwrap();
        assert_eq!(created.machine_id, MACHINE_ID);

        let existing_path = root.join(machine_rel_path(MACHINE_ID).unwrap());
        let before = std::fs::read(&existing_path).unwrap();
        let (loaded, _) = load_or_create_vault_machine(
            &root,
            MACHINE_ID,
            &profile(),
            at("2026-10-28T08:00:00.000Z"),
            "/tmp/autre",
        )
        .unwrap();
        assert_eq!(loaded, created);
        assert_eq!(std::fs::read(&existing_path).unwrap(), before);
    }

    #[test]
    fn day_start_is_idempotent_per_logical_day() {
        let (_dir, root) = vault();
        load_or_create_vault_machine(
            &root,
            MACHINE_ID,
            &profile(),
            at("2026-10-27T08:00:00.000Z"),
            "/tmp/vault",
        )
        .unwrap();

        let initial = day_state(
            &root,
            MACHINE_ID,
            4,
            Tz::UTC,
            at("2026-10-27T10:00:00.000Z"),
        )
        .unwrap();
        assert!(!initial.started);
        assert_eq!(initial.logical_day, "2026-10-27");

        let started = day_start(
            &root,
            MACHINE_ID,
            4,
            Tz::UTC,
            at("2026-10-27T10:00:00.000Z"),
        )
        .unwrap();
        assert!(started.started);
        assert_eq!(
            started.last_day_started_at.as_deref(),
            Some("2026-10-27T10:00:00.000Z")
        );

        let again = day_start(
            &root,
            MACHINE_ID,
            4,
            Tz::UTC,
            at("2026-10-27T18:00:00.000Z"),
        )
        .unwrap();
        assert!(again.started);
        assert_eq!(
            again.last_day_started_at.as_deref(),
            Some("2026-10-27T10:00:00.000Z")
        );
    }

    #[test]
    fn late_night_marker_is_written_once_per_logical_day() {
        let (_dir, root) = vault();
        load_or_create_vault_machine(
            &root,
            MACHINE_ID,
            &profile(),
            at("2026-10-27T08:00:00.000Z"),
            "/tmp/vault",
        )
        .unwrap();

        let first = mark_late_night_shown(
            &root,
            MACHINE_ID,
            4,
            Tz::UTC,
            at("2026-10-28T02:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(first.late_night_shown_for.as_deref(), Some("2026-10-27"));
        let (_, reference) = read_vault_machine(&root, MACHINE_ID).unwrap();

        let second = mark_late_night_shown(
            &root,
            MACHINE_ID,
            4,
            Tz::UTC,
            at("2026-10-28T02:30:00.000Z"),
        )
        .unwrap();
        assert_eq!(second.late_night_shown_for.as_deref(), Some("2026-10-27"));
        let (_, unchanged) = read_vault_machine(&root, MACHINE_ID).unwrap();
        assert_eq!(reference.hash, unchanged.hash);
    }

    #[test]
    fn local_state_patch_requires_the_current_revision() {
        let (_dir, root) = vault();
        load_or_create_vault_machine(
            &root,
            MACHINE_ID,
            &profile(),
            at("2026-10-27T08:00:00.000Z"),
            "/tmp/vault",
        )
        .unwrap();
        let (_, reference) = read_vault_machine(&root, MACHINE_ID).unwrap();
        let before = std::fs::read(root.join(machine_rel_path(MACHINE_ID).unwrap())).unwrap();

        let error = patch_local_state(
            &root,
            MACHINE_ID,
            &serde_json::json!({ "lastFullScanAt": "2026-10-27T09:00:00.000Z" }),
            &"0".repeat(64),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(
            std::fs::read(root.join(machine_rel_path(MACHINE_ID).unwrap())).unwrap(),
            before
        );

        let (patched, revision) = patch_local_state(
            &root,
            MACHINE_ID,
            &serde_json::json!({ "lastFullScanAt": "2026-10-27T09:00:00.000Z" }),
            &reference.hash,
        )
        .unwrap();
        assert_eq!(
            patched.last_full_scan_at.as_deref(),
            Some("2026-10-27T09:00:00.000Z")
        );
        assert_ne!(revision, reference.hash);
    }

    fn save_dated_reminder(
        root: &Path,
        list_id: &str,
        id: &str,
        title: &str,
        due_date: Option<&str>,
        status: ReminderStatus,
        at: DateTime<Utc>,
    ) {
        let reminder = Reminder {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            list_id: list_id.to_string(),
            title: title.to_string(),
            notes: None,
            status: status.clone(),
            due_date: due_date.map(str::to_string),
            due_time: None,
            due_time_zone: None,
            project_id: None,
            completed_at: (status == ReminderStatus::Done).then(|| to_iso(at)),
            abandoned_at: None,
            recurrence: None,
            sort_key: None,
            created_at: String::new(),
            updated_at: String::new(),
            machine_id: String::new(),
            extra: serde_json::Map::new(),
        };
        crate::services::reminders::save(root, reminder, None, MACHINE_ID, at).unwrap();
    }

    #[test]
    fn day_state_reports_untreated_reminders_and_respects_the_carry_over_journal() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault")
            .unwrap();
        let lists = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap();
        let list_id = lists[0].id.clone();

        const PREV_OPEN: &str = "0199a1b2-0000-7000-8000-000000000101";
        const PREV_DONE: &str = "0199a1b2-0000-7000-8000-000000000102";
        const PREV_CANCELLED: &str = "0199a1b2-0000-7000-8000-000000000103";
        const TODAY_OPEN: &str = "0199a1b2-0000-7000-8000-000000000104";
        const TOMORROW_OPEN: &str = "0199a1b2-0000-7000-8000-000000000105";
        const OLD_OPEN: &str = "0199a1b2-0000-7000-8000-000000000106";
        const NO_DUE: &str = "0199a1b2-0000-7000-8000-000000000107";

        save_dated_reminder(
            &root,
            &list_id,
            PREV_OPEN,
            "Veille ouverte",
            Some("2026-10-27"),
            ReminderStatus::Open,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            PREV_DONE,
            "Veille terminée",
            Some("2026-10-27"),
            ReminderStatus::Done,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            PREV_CANCELLED,
            "Veille annulée",
            Some("2026-10-27"),
            ReminderStatus::Cancelled,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            TODAY_OPEN,
            "Aujourd'hui",
            Some("2026-10-28"),
            ReminderStatus::Open,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            TOMORROW_OPEN,
            "Demain",
            Some("2026-10-29"),
            ReminderStatus::Open,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            OLD_OPEN,
            "Plus ancien",
            Some("2026-10-20"),
            ReminderStatus::Open,
            setup_at,
        );
        save_dated_reminder(
            &root,
            &list_id,
            NO_DUE,
            "Sans échéance",
            None,
            ReminderStatus::Open,
            setup_at,
        );

        let day = at("2026-10-28T09:00:00.000Z");
        let state = day_state(&root, MACHINE_ID, 4, Tz::UTC, day).unwrap();
        assert_eq!(state.logical_day, "2026-10-28");
        let ids: Vec<&str> = state
            .carry_over_candidates
            .iter()
            .map(|reminder| reminder.id.as_str())
            .collect();
        // Tri de `services::reminders::list` : échéance croissante, puis les
        // rappels sans échéance en dernier. Seule la veille et plus ancien
        // restent : terminé, annulé, aujourd'hui, demain et sans échéance sont
        // exclus.
        assert_eq!(ids, vec![OLD_OPEN, PREV_OPEN]);

        let started = day_start(&root, MACHINE_ID, 4, Tz::UTC, day).unwrap();
        let started_ids: Vec<&str> = started
            .carry_over_candidates
            .iter()
            .map(|reminder| reminder.id.as_str())
            .collect();
        assert_eq!(started_ids, vec![OLD_OPEN, PREV_OPEN]);

        let late = mark_late_night_shown(&root, MACHINE_ID, 4, Tz::UTC, day).unwrap();
        let late_ids: Vec<&str> = late
            .carry_over_candidates
            .iter()
            .map(|reminder| reminder.id.as_str())
            .collect();
        assert_eq!(late_ids, vec![OLD_OPEN, PREV_OPEN]);

        // Journal des actions : seule l'entrée portant la veille comme
        // `sourceDay` retire son rappel. Une entrée d'une autre journée ne doit
        // pas exclure un reste.
        let (_, reference) = read_vault_machine(&root, MACHINE_ID).unwrap();
        let (patched, _) = patch_local_state(
            &root,
            MACHINE_ID,
            &serde_json::json!({
                "reminderHistory": [
                    {
                        "id": "0199a1b2-0000-7000-8000-000000000201",
                        "reminderId": PREV_OPEN,
                        "action": "abandon",
                        "sourceDay": "2026-10-27",
                        "logicalDay": "2026-10-28",
                        "dueDate": "2026-10-27",
                        "newDueDate": null,
                        "createdAt": "2026-10-28T09:01:00.000Z",
                        "resolvedAt": "2026-10-28T09:01:01.000Z"
                    },
                    {
                        "id": "0199a1b2-0000-7000-8000-000000000202",
                        "reminderId": OLD_OPEN,
                        "action": "tomorrow",
                        "sourceDay": "2026-10-26",
                        "logicalDay": "2026-10-27",
                        "dueDate": "2026-10-20",
                        "newDueDate": "2026-10-27",
                        "createdAt": "2026-10-26T09:01:00.000Z",
                        "resolvedAt": null
                    }
                ]
            }),
            &reference.hash,
        )
        .unwrap();
        assert_eq!(patched.reminder_history.len(), 2);

        let after = day_state(&root, MACHINE_ID, 4, Tz::UTC, day).unwrap();
        let after_ids: Vec<&str> = after
            .carry_over_candidates
            .iter()
            .map(|reminder| reminder.id.as_str())
            .collect();
        assert_eq!(
            after_ids,
            vec![OLD_OPEN],
            "une entrée reminderHistory de la veille exclut son rappel, pas ceux d'une autre sourceDay"
        );
    }

    #[test]
    fn pending_injection_after_pending_write_is_reconciled_after_restart_without_duplicate() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault").unwrap();
        let list_id = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap()[0].id.clone();
        const ID: &str = "0199a1b2-0000-7000-8000-000000000401";
        save_dated_reminder(&root, &list_id, ID, "Injection pending", Some("2026-10-27"), ReminderStatus::Open, setup_at);
        let expected = crate::services::reminders::get_file_ref(&root, ID).unwrap().hash;

        set_test_failpoint(Some(TestFailpoint::AfterPendingWrite));
        let error = apply_reminder_action(&root, MACHINE_ID, ID, CarryOverAction::Replan, Some("2026-10-30"), &expected, "2026-10-27", "2026-10-28", at("2026-10-28T09:00:00.000Z")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(crate::services::reminders::read_reminder(&root, ID).unwrap().due_date.as_deref(), Some("2026-10-27"));

        let (restarted, _) = load_or_create_vault_machine(&root, MACHINE_ID, &profile(), at("2026-10-28T10:00:00.000Z"), "/tmp/other").unwrap();
        assert_eq!(crate::services::reminders::read_reminder(&root, ID).unwrap().due_date.as_deref(), Some("2026-10-30"));
        assert_eq!(restarted.local_state.reminder_history.len(), 1);
        assert!(matches!(restarted.local_state.reminder_history[0].status, ReminderHistoryStatus::Applied));
        let (again, _) = reconcile_pending(&root, MACHINE_ID, at("2026-10-28T11:00:00.000Z")).unwrap();
        assert_eq!(again.local_state.reminder_history.len(), 1, "rejeu sans doublon");
    }

    #[test]
    fn reminder_write_injection_after_reminder_write_is_reconciled_after_restart_once() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault").unwrap();
        let list_id = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap()[0].id.clone();
        const ID: &str = "0199a1b2-0000-7000-8000-000000000402";
        save_dated_reminder(&root, &list_id, ID, "Injection rappel", Some("2026-10-27"), ReminderStatus::Open, setup_at);
        let expected = crate::services::reminders::get_file_ref(&root, ID).unwrap().hash;

        set_test_failpoint(Some(TestFailpoint::AfterReminderWrite));
        let error = apply_reminder_action(&root, MACHINE_ID, ID, CarryOverAction::Abandon, None, &expected, "2026-10-27", "2026-10-28", at("2026-10-28T09:00:00.000Z")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(crate::services::reminders::read_reminder(&root, ID).unwrap().status, ReminderStatus::Abandoned);

        let (restarted, _) = load_or_create_vault_machine(&root, MACHINE_ID, &profile(), at("2026-10-28T10:00:00.000Z"), "/tmp/other").unwrap();
        assert_eq!(restarted.local_state.reminder_history.len(), 1);
        assert!(matches!(restarted.local_state.reminder_history[0].status, ReminderHistoryStatus::Applied));
        let (again, _) = reconcile_pending(&root, MACHINE_ID, at("2026-10-28T11:00:00.000Z")).unwrap();
        assert_eq!(again.local_state.reminder_history.len(), 1, "rejeu ne double pas l'application");
    }

    #[test]
    fn report_actions_preserve_unknown_numeric_and_array_extensions_and_abandon_masks() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault").unwrap();
        let list_id = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap()[0].id.clone();
        let actions = [CarryOverAction::Tomorrow, CarryOverAction::Replan, CarryOverAction::Abandon, CarryOverAction::Restore];
        for (index, action) in actions.into_iter().enumerate() {
            let id = format!("0199a1b2-0000-7000-8000-0000000005{:02}", index + 1);
            save_dated_reminder(&root, &list_id, &id, "extensions", Some("2026-10-27"), if action == CarryOverAction::Restore { ReminderStatus::Abandoned } else { ReminderStatus::Open }, setup_at);
            let path = root.join("reminders").join(format!("{id}.json"));
            let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            value["futureNumber"] = serde_json::json!(99);
            value["futureNested"] = serde_json::json!({"number": 7, "array": [1, 2, 3]});
            std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            let expected = crate::services::reminders::get_file_ref(&root, &id).unwrap().hash;
            let due = (action == CarryOverAction::Tomorrow || action == CarryOverAction::Replan).then_some("2026-10-30");
            apply_reminder_action(&root, MACHINE_ID, &id, action, due, &expected, "2026-10-27", "2026-10-28", at("2026-10-28T09:00:00.000Z")).unwrap();
            let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(persisted["futureNumber"], 99);
            assert_eq!(persisted["futureNested"], serde_json::json!({"number": 7, "array": [1, 2, 3]}));
            let listed = crate::services::reminders::list(&root, None, setup_at, 4, Tz::UTC).unwrap();
            if action == CarryOverAction::Abandon { assert!(!listed.iter().any(|item| item.id == id), "abandoned must be masked"); }
            if action == CarryOverAction::Restore { assert!(listed.iter().any(|item| item.id == id)); }
        }
    }

    #[test]
    fn abandon_restore_report_and_replan_are_idempotent_and_restore_clears_abandoned_at() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault").unwrap();
        let list_id = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap()[0].id.clone();
        const ID: &str = "0199a1b2-0000-7000-8000-000000000403";
        save_dated_reminder(&root, &list_id, ID, "Décisions", Some("2026-10-27"), ReminderStatus::Open, setup_at);
        let expected = crate::services::reminders::get_file_ref(&root, ID).unwrap().hash;
        apply_reminder_action(&root, MACHINE_ID, ID, CarryOverAction::Abandon, None, &expected, "2026-10-27", "2026-10-28", at("2026-10-28T09:00:00.000Z")).unwrap();
        let abandoned = crate::services::reminders::read_reminder(&root, ID).unwrap();
        assert_eq!(abandoned.status, ReminderStatus::Abandoned);
        assert!(abandoned.abandoned_at.is_some());
        let expected = crate::services::reminders::get_file_ref(&root, ID).unwrap().hash;
        apply_reminder_action(&root, MACHINE_ID, ID, CarryOverAction::Restore, None, &expected, "2026-10-27", "2026-10-29", at("2026-10-29T09:00:00.000Z")).unwrap();
        let restored = crate::services::reminders::read_reminder(&root, ID).unwrap();
        assert_eq!(restored.status, ReminderStatus::Open);
        assert!(restored.abandoned_at.is_none());
        let history = read_vault_machine(&root, MACHINE_ID).unwrap().0.local_state.reminder_history;
        assert_eq!(history.iter().filter(|e| e.reminder_id == ID).count(), 2);
    }

    #[test]
    fn day_state_and_day_start_survive_an_unreadable_reminder_without_touching_it() {
        let (_dir, root) = vault();
        let setup_at = at("2026-10-27T08:00:00.000Z");
        load_or_create_vault_machine(&root, MACHINE_ID, &profile(), setup_at, "/tmp/vault")
            .unwrap();
        let lists = crate::services::reminders::list_defs(&root, MACHINE_ID, setup_at).unwrap();
        let list_id = lists[0].id.clone();

        const VALID: &str = "0199a1b2-0000-7000-8000-000000000301";
        save_dated_reminder(
            &root,
            &list_id,
            VALID,
            "Reste lisible",
            Some("2026-10-27"),
            ReminderStatus::Open,
            setup_at,
        );

        // Fichier de rappel volontairement corrompu : JSON tronqué, nom d'UUID
        // valide pour être bien visité par le lecteur tolérant.
        const BROKEN: &str = "0199a1b2-0000-7000-8000-000000000302";
        let broken_path = root.join("reminders").join(format!("{BROKEN}.json"));
        let broken_bytes = br#"{ "schemaVersion": 1, "id": "#.to_vec();
        std::fs::write(&broken_path, &broken_bytes).unwrap();

        let day = at("2026-10-28T09:00:00.000Z");
        let state = day_state(&root, MACHINE_ID, 4, Tz::UTC, day)
            .expect("un rappel illisible ne doit jamais empêcher l'accueil de s'afficher");

        let ids: Vec<&str> = state
            .carry_over_candidates
            .iter()
            .map(|reminder| reminder.id.as_str())
            .collect();
        assert_eq!(ids, vec![VALID], "le rappel lisible reste un candidat");
        assert_eq!(
            state.carry_over_warnings.len(),
            1,
            "un avertissement par fichier ignoré"
        );
        let warning = &state.carry_over_warnings[0];
        assert!(
            warning.contains(BROKEN) && warning.contains("reminders/"),
            "l'avertissement doit nommer le fichier : {warning}"
        );
        assert!(
            warning.contains("E_SCHEMA_INVALID"),
            "l'avertissement doit porter le code d'erreur : {warning}"
        );
        assert_eq!(
            std::fs::read(&broken_path).unwrap(),
            broken_bytes,
            "le fichier corrompu ne doit être ni réécrit ni supprimé"
        );

        let started = day_start(&root, MACHINE_ID, 4, Tz::UTC, day)
            .expect("day_start doit réussir malgré un rappel illisible");
        assert!(started.started);
        assert_eq!(started.carry_over_warnings, state.carry_over_warnings);
        assert_eq!(
            std::fs::read(&broken_path).unwrap(),
            broken_bytes,
            "day_start ne touche pas au fichier corrompu"
        );

        let late = mark_late_night_shown(&root, MACHINE_ID, 4, Tz::UTC, day)
            .expect("mark_late_night_shown doit réussir malgré un rappel illisible");
        assert_eq!(late.carry_over_warnings, state.carry_over_warnings);
        assert_eq!(
            std::fs::read(&broken_path).unwrap(),
            broken_bytes,
            "mark_late_night_shown ne touche pas au fichier corrompu"
        );
    }
}

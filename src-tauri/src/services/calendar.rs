//! Agenda local V1 : un fichier `.ics` par événement (`calendar/<eventId>.ics`).
//!
//! Miroir de `services::reminders` pour les événements locaux.

use std::path::Path;

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use uuid::Uuid;

use crate::error::{DayaliError, ErrorCode};
use crate::models::calendar::{EventTimePoint, LocalCalendarEvent};
use crate::models::common::{
    is_project_id, is_sha256_hex, is_uuid, nfc, parse_iso, to_iso, FileRef, Precondition,
};
use crate::services::{self, ics};
use crate::vault::{atomic, fs as vault_fs, paths as vault_paths};

pub const CALENDAR_DIR: &str = "calendar";
pub const TRASH_CALENDAR_DIR: &str = ".dayali/trash/calendar";
pub const MAX_EVENT_BYTES: usize = 256 * 1024;

const MAX_CONFLICT_ATTEMPTS: usize = 100;

fn calendar_rel_path(id: &str) -> String {
    format!("{CALENDAR_DIR}/{id}.ics")
}

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

fn is_conflict_name(name: &str) -> bool {
    name.contains(".conflict-")
}

fn ics_files(dir: &Path) -> Result<Vec<String>, DayaliError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(DayaliError::from_io(&error, "dossier du calendrier illisible")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| DayaliError::from_io(&error, "entrée du dossier illisible"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| DayaliError::from_io(&error, "type d'entrée illisible"))?;
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        if name.ends_with(".ics") && !is_conflict_name(&name) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub fn read_event(root: &Path, id: &str, fallback_tz: &str) -> Result<LocalCalendarEvent, DayaliError> {
    validate_entity_id(id, "/id")?;
    let rel = calendar_rel_path(id);
    let (text, _) = vault_fs::read_text(root, &rel, MAX_EVENT_BYTES)?;
    ics::from_ics(&text, id, fallback_tz)
}

pub fn list_tolerant(
    root: &Path,
    fallback_tz: &str,
) -> Result<(Vec<LocalCalendarEvent>, Vec<String>), DayaliError> {
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for name in ics_files(&root.join(CALENDAR_DIR))? {
        let Some(id) = name.strip_suffix(".ics") else {
            continue;
        };
        if !is_uuid(id) {
            continue;
        }
        match read_event(root, id, fallback_tz) {
            Ok(event) => items.push(event),
            Err(error) => warnings.push(format!(
                "calendar/{id}.ics : {} — {}",
                error.code.as_str(),
                error.message
            )),
        }
    }
    items.sort_by(|left, right| left.id.cmp(&right.id));
    Ok((items, warnings))
}

pub fn get_file_ref(root: &Path, id: &str) -> Result<FileRef, DayaliError> {
    validate_entity_id(id, "/id")?;
    vault_fs::file_ref(root, &calendar_rel_path(id))
}

/// Filtre et trie les événements locaux pour la fenêtre civile inclusive.
/// L'intersection est calculée avec une borne de fin exclusive (lendemain de
/// `to`), ce qui conserve le contrat des événements toute la journée.
pub fn list_window(
    root: &Path,
    fallback_tz: &str,
    from: &str,
    to: &str,
    display_tz: Tz,
) -> Result<(Vec<LocalCalendarEvent>, Vec<String>), DayaliError> {
    let from_date = NaiveDate::parse_from_str(from, "%Y-%m-%d")
        .map_err(|_| DayaliError::schema_invalid("/from", "date attendue : YYYY-MM-DD"))?;
    let to_date = NaiveDate::parse_from_str(to, "%Y-%m-%d")
        .map_err(|_| DayaliError::schema_invalid("/to", "date attendue : YYYY-MM-DD"))?;
    if from_date > to_date {
        return Err(DayaliError::schema_invalid(
            "/to",
            "la date de fin doit être postérieure ou égale à la date de début",
        ));
    }
    let end_date = to_date.succ_opt().ok_or_else(|| {
        DayaliError::schema_invalid("/to", "date de fin hors limites")
    })?;
    let from_midnight = display_tz
        .from_local_datetime(&from_date.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or_else(|| DayaliError::schema_invalid("/from", "date locale ambiguë"))?
        .with_timezone(&Utc);
    let end_midnight = display_tz
        .from_local_datetime(&end_date.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or_else(|| DayaliError::schema_invalid("/to", "date locale ambiguë"))?
        .with_timezone(&Utc);
    let (events, warnings) = list_tolerant(root, fallback_tz)?;
    let mut items: Vec<_> = events
        .into_iter()
        .filter(|event| match (&event.start, &event.end) {
            (EventTimePoint::Date { date: start }, EventTimePoint::Date { date: end }) => {
                let Ok(start) = NaiveDate::parse_from_str(start, "%Y-%m-%d") else { return false };
                let Ok(end) = NaiveDate::parse_from_str(end, "%Y-%m-%d") else { return false };
                start < end_date && end > from_date
            }
            (EventTimePoint::DateTime { date_time: start, .. }, EventTimePoint::DateTime { date_time: end, .. }) => {
                *start < end_midnight && *end > from_midnight
            }
            _ => false,
        })
        .collect();
    items.sort_by(|left, right| {
        fn key(event: &LocalCalendarEvent, tz: Tz) -> (i64, &str) {
            let timestamp = match &event.start {
                EventTimePoint::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()
                    .and_then(|date| tz.from_local_datetime(&date.and_hms_opt(0, 0, 0)?).single())
                    .map(|date| date.timestamp())
                    .unwrap_or(i64::MIN),
                EventTimePoint::DateTime { date_time, .. } => date_time.timestamp(),
            };
            (timestamp, event.id.as_str())
        }
        key(left, display_tz).cmp(&key(right, display_tz))
    });
    Ok((items, warnings))
}

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
    let stem = file_name.strip_suffix(".ics").unwrap_or(file_name);
    let stamp = at.format("%Y%m%dT%H%M%SZ").to_string();

    for attempt in 0..MAX_CONFLICT_ATTEMPTS {
        let name = match attempt {
            0 => file_name.to_string(),
            1 => format!("{stem}-{stamp}.ics"),
            other => format!("{stem}-{stamp}-{other}.ics"),
        };
        let trash_rel = format!("{trash_dir_rel}/{name}");
        match std::fs::symlink_metadata(root.join(&trash_rel)) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(DayaliError::from_io(&error, "corbeille inaccessible"));
            }
        }
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

pub fn delete(
    root: &Path,
    id: &str,
    expected: &str,
    at: DateTime<Utc>,
) -> Result<(), DayaliError> {
    validate_entity_id(id, "/id")?;
    validate_expected(Some(expected))?;

    let rel = calendar_rel_path(id);
    let metadata = std::fs::symlink_metadata(root.join(&rel))
        .map_err(|error| DayaliError::from_io(&error, "événement introuvable"))?;
    if metadata.file_type().is_symlink() {
        return Err(DayaliError::path_escape(
            "suppression refusée sur un symlink d'événement",
        ));
    }
    let current = vault_fs::file_ref(root, &rel)?;
    if current.hash != expected {
        return Err(services::precondition_failed(
            "l'événement a changé depuis la lecture : recharge avant de supprimer",
            &current,
        ));
    }
    move_to_trash(root, &rel, TRASH_CALENDAR_DIR, at)
}

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
        let rel = format!("{dir_rel}/{id}.conflict-{suffix}.ics");
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

pub fn save(
    root: &Path,
    incoming: LocalCalendarEvent,
    expected: Option<&str>,
    machine_id: &str,
    at: DateTime<Utc>,
    fallback_tz: &str,
) -> Result<LocalCalendarEvent, DayaliError> {
    validate_expected(expected)?;
    validate_entity_id(machine_id, "/machineId")?;

    let id = if incoming.id.is_empty() {
        Uuid::now_v7().to_string()
    } else {
        validate_entity_id(&incoming.id, "/id")?;
        incoming.id.clone()
    };

    let existing = match read_event(root, &id, fallback_tz) {
        Ok(event) => Some(event),
        Err(error) if error.code == ErrorCode::NotFound => None,
        Err(error) => return Err(error),
    };

    if existing.is_none() && expected.is_some() {
        let mut candidate = incoming.clone();
        candidate.id = id.clone();
        candidate.uid = format!("{id}@dayali.local");
        candidate.calendar_id = "local".to_string();
        candidate.machine_id = Some(machine_id.to_string());
        candidate.created_at = parse_iso(&incoming.created_at)
            .map(to_iso)
            .unwrap_or_else(|_| to_iso(at));
        candidate.updated_at = to_iso(at);
        candidate.sequence = if incoming.sequence < 0 {
            0
        } else {
            incoming.sequence
        };
        if let Ok(bytes) = ics::to_ics(&candidate) {
            write_conflict_copy(root, CALENDAR_DIR, &id, bytes.as_bytes(), machine_id, at);
        }
        return Err(precondition_missing(&calendar_rel_path(&id)));
    }

    let created_at = if let Some(existing) = &existing {
        existing.created_at.clone()
    } else {
        parse_iso(&incoming.created_at)
            .map(to_iso)
            .unwrap_or_else(|_| to_iso(at))
    };

    let mut event = incoming;
    event.id = id.clone();
    event.uid = format!("{id}@dayali.local");
    event.calendar_id = "local".to_string();
    event.created_at = created_at;
    event.updated_at = to_iso(at);
    event.machine_id = Some(machine_id.to_string());
    event.sequence = if let Some(existing) = &existing {
        existing.sequence + 1
    } else if event.sequence < 0 {
        0
    } else {
        event.sequence
    };

    event.validate()?;
    if let Some(project_id) = &event.project_id {
        if !is_project_id(project_id) {
            return Err(DayaliError::schema_invalid(
                "/projectId",
                "projectId doit respecter le motif <slug>--<8 hex> (minuscules, 11 à 58 caractères)",
            ));
        }
    }

    let bytes = ics::to_ics(&event)?.into_bytes();
    let precondition = expected.map(Precondition::hash);

    match atomic::write_vault_bytes(
        root,
        &calendar_rel_path(&id),
        &bytes,
        precondition.as_ref(),
        true,
    ) {
        Ok(_) => Ok(event),
        Err(error) if error.code == ErrorCode::PreconditionFailed => {
            write_conflict_copy(root, CALENDAR_DIR, &id, &bytes, machine_id, at);
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use crate::app_state::{AppState, LocalSlot};
    use crate::error::ErrorCode;
    use crate::models::calendar::{EventStatus, EventTimePoint, LocalCalendarEvent};
    use crate::models::common::{parse_iso, AppPaths};
    use crate::models::machine::{Arch, MachineProfile, Platform};
    use crate::services::{machine, vault};
    use crate::vault::hash;

    const T0: &str = "2026-10-27T08:00:00.000Z";
    const T1: &str = "2026-10-27T09:30:00.000Z";

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

    fn app_state(dir: &std::path::Path) -> AppState {
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

    struct Harness {
        dir: tempfile::TempDir,
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
            let (root, machine_id) = state
                .with_vault(|open| Ok((open.root.clone(), open.machine_id.clone())))
                .unwrap();
            Self {
                dir,
                state,
                root,
                machine_id,
            }
        }

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

    fn new_event(all_day: bool) -> LocalCalendarEvent {
        if all_day {
            LocalCalendarEvent::new(
                "",
                "",
                "Journée",
                true,
                EventTimePoint::Date {
                    date: "2026-10-27".to_string(),
                },
                EventTimePoint::Date {
                    date: "2026-10-28".to_string(),
                },
                EventStatus::Confirmed,
                0,
                "",
                "",
                None,
                None,
            )
        } else {
            LocalCalendarEvent::new(
                "",
                "",
                "Point",
                false,
                EventTimePoint::DateTime {
                    date_time: parse_iso("2026-10-27T08:30:00.000Z").unwrap(),
                    time_zone: "Europe/Paris".to_string(),
                },
                EventTimePoint::DateTime {
                    date_time: parse_iso("2026-10-27T09:30:00.000Z").unwrap(),
                    time_zone: "Europe/Paris".to_string(),
                },
                EventStatus::Confirmed,
                0,
                "",
                "",
                None,
                None,
            )
        }
    }

    #[test]
    fn create_read_roundtrip_and_restart() {
        let h = Harness::new();
        let saved = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        assert!(!saved.id.is_empty());
        let read = read_event(&h.root, &saved.id, "Europe/Paris").unwrap();
        let mut expected = saved.clone();
        expected.machine_id = None;
        assert_eq!(read, expected);
        // restart
        let st = h.restart();
        let (root, _) = st.with_vault(|o| Ok((o.root.clone(), o.machine_id.clone()))).unwrap();
        let read2 = read_event(&root, &saved.id, "Europe/Paris").unwrap();
        let mut expected2 = saved.clone();
        expected2.machine_id = None;
        assert_eq!(read2, expected2);
    }

    #[test]
    fn edit_with_expected_hash() {
        let h = Harness::new();
        let created = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let current = get_file_ref(&h.root, &created.id).unwrap();
        let mut incoming = created.clone();
        incoming.title = "Mis à jour".to_string();
        let saved = save(&h.root, incoming, Some(&current.hash), &h.machine_id, instant(T1), "Europe/Paris").unwrap();
        assert_eq!(saved.title, "Mis à jour");
        assert_eq!(saved.updated_at, T1);
    }

    #[test]
    fn delete_moves_to_trash() {
        let h = Harness::new();
        let created = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let current = get_file_ref(&h.root, &created.id).unwrap();
        delete(&h.root, &created.id, &current.hash, instant(T1)).unwrap();
        assert!(!h.root.join(CALENDAR_DIR).join(format!("{}.ics", created.id)).exists());
        assert!(h.root.join(TRASH_CALENDAR_DIR).join(format!("{}.ics", created.id)).is_file());
    }

    #[test]
    fn stale_hash_writes_conflict_copy() {
        let h = Harness::new();
        let created = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let path = h.root.join(CALENDAR_DIR).join(format!("{}.ics", created.id));
        let before = std::fs::read(&path).unwrap();
        let stale = hash::sha256_bytes(b"autre");
        let mut incoming = created.clone();
        incoming.title = "Concurrent".to_string();
        let err = save(&h.root, incoming, Some(&stale), &h.machine_id, instant(T1), "Europe/Paris").unwrap_err();
        assert_eq!(err.code, ErrorCode::PreconditionFailed);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let conflicts: Vec<_> = std::fs::read_dir(h.root.join(CALENDAR_DIR)).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".conflict-"))
            .collect();
        assert_eq!(conflicts.len(), 1);
    }

    #[test]
    fn list_window_rejects_inverted_range() {
        let h = Harness::new();
        let error = list_window(&h.root, "Europe/Paris", "2026-10-28", "2026-10-27", "Europe/Paris".parse().unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
    }

    #[test]
    fn list_window_intersects_exclusive_all_day_end_and_sorts() {
        let h = Harness::new();
        let mut later = new_event(true);
        later.id = "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c6e".to_string();
        later.uid = format!("{}@dayali.local", later.id);
        later.start = EventTimePoint::Date { date: "2026-10-29".to_string() };
        later.end = EventTimePoint::Date { date: "2026-10-30".to_string() };
        save(&h.root, later, None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        save(&h.root, new_event(true), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let (items, warnings) = list_window(&h.root, "Europe/Paris", "2026-10-28", "2026-10-29", "Europe/Paris".parse().unwrap()).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].start.to_iso(), "2026-10-29");
    }

    #[test]
    fn corrupt_file_ignored_with_warning() {
        let h = Harness::new();
        let created = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let path = h.root.join(CALENDAR_DIR).join(format!("{}.ics", created.id));
        let before = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"not ics").unwrap();
        let (items, warnings) = list_tolerant(&h.root, "Europe/Paris").unwrap();
        assert!(items.is_empty());
        assert_eq!(warnings.len(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), b"not ics");
        // restore
        std::fs::write(&path, before).unwrap();
    }

    #[test]
    fn all_day_value_date() {
        let h = Harness::new();
        let saved = save(&h.root, new_event(true), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let bytes = std::fs::read(h.root.join(CALENDAR_DIR).join(format!("{}.ics", saved.id))).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("VALUE=DATE"));
        let back = read_event(&h.root, &saved.id, "Europe/Paris").unwrap();
        assert!(back.all_day);
    }

    #[test]
    fn roundtrip_ics_equality_except_machine_id() {
        let h = Harness::new();
        let ev = save(&h.root, new_event(false), None, &h.machine_id, instant(T0), "Europe/Paris").unwrap();
        let ics = ics::to_ics(&ev).unwrap();
        let back = ics::from_ics(&ics, &ev.id, "Europe/Paris").unwrap();
        let mut expected = ev.clone();
        expected.machine_id = None;
        assert_eq!(back, expected);
    }
}

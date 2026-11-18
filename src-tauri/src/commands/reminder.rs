//! Commandes rappels (étape (c)) : listes multiples, « Ma journée », sauvegarde.
//!
//! Commandes IPC (PLAN §5.6) :
//!  - `reminder_list`         ← `{ filter? }`         → `Reminder[]`
//!  - `reminder_save`         ← `{ reminder, expected? }` → `Reminder`
//!  - `reminder_delete`       ← `{ id, expected }`    → `void`
//!  - `reminder_list_defs`    ← —                    → `ReminderList[]`
//!  - `reminder_list_save`    ← `{ list, expected? }` → `ReminderList`
//!  - `reminder_list_delete`  ← `{ id, expected }`    → `void`
//!  - `reminder_file_ref`     ← `{ id }`              → `FileRef`
//!
//! Toute écriture prend `AppState::lock_writes` ici (jamais dans le service,
//! qui reste testable sans Tauri) et délègue à `services::reminders`. Aucune
//! commande ne renvoie un `Ok` vide : sans vault, `E_VAULT_NOT_OPEN` remonte.

use chrono::Utc;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{vault_context, vault_ids};
use crate::error::DayaliError;
use crate::models::common::FileRef;
use crate::models::machine::CarryOverAction;
use crate::models::reminders::{Reminder, ReminderList, RemindersFilter};
use crate::services::machine as machine_svc;
use crate::services::reminders as svc;

/// Mapping Tauri : `reminder_list` ← `invoke("reminder_list", { filter? })`
#[tauri::command]
pub fn reminder_list(
    state: State<'_, AppState>,
    filter: Option<RemindersFilter>,
) -> Result<Vec<Reminder>, DayaliError> {
    let (root, _, day_start_hour, time_zone) = vault_context(&state)?;
    reminder_list_from_root(
        &root,
        filter.as_ref(),
        Utc::now(),
        day_start_hour,
        time_zone,
    )
}

fn reminder_list_from_root(
    root: &std::path::Path,
    filter: Option<&RemindersFilter>,
    at: chrono::DateTime<Utc>,
    day_start_hour: u32,
    time_zone: chrono_tz::Tz,
) -> Result<Vec<Reminder>, DayaliError> {
    svc::list(root, filter, at, day_start_hour, time_zone)
}

/// Mapping Tauri : `reminder_save` ← `invoke("reminder_save", { reminder, expected? })`
#[tauri::command]
pub fn reminder_save(
    state: State<'_, AppState>,
    reminder: Reminder,
    expected: Option<String>,
) -> Result<Reminder, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    svc::save(
        &root,
        reminder,
        expected.as_deref(),
        &machine_id,
        Utc::now(),
    )
}

/// Mapping Tauri : `reminder_delete` ← `invoke("reminder_delete", { id, expected })`
#[tauri::command]
pub fn reminder_delete(
    state: State<'_, AppState>,
    id: String,
    expected: String,
) -> Result<(), DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, _) = vault_ids(&state)?;
    svc::delete(&root, &id, &expected, Utc::now())
}

/// Mapping Tauri : `reminder_list_defs` ← `invoke("reminder_list_defs")`
///
/// Peut créer la liste par défaut « À faire » : c'est une écriture, donc le
/// verrou est pris même si l'appel est en lecture la plupart du temps.
#[tauri::command]
pub fn reminder_list_defs(state: State<'_, AppState>) -> Result<Vec<ReminderList>, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    svc::list_defs(&root, &machine_id, Utc::now())
}

/// Mapping Tauri : `reminder_list_save` ← `invoke("reminder_list_save", { list, expected? })`
#[tauri::command]
pub fn reminder_list_save(
    state: State<'_, AppState>,
    list: ReminderList,
    expected: Option<String>,
) -> Result<ReminderList, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    svc::list_save(&root, list, expected.as_deref(), &machine_id, Utc::now())
}

/// Mapping Tauri : `reminder_list_delete` ← `invoke("reminder_list_delete", { id, expected })`
#[tauri::command]
pub fn reminder_list_delete(
    state: State<'_, AppState>,
    id: String,
    expected: String,
) -> Result<(), DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, _) = vault_ids(&state)?;
    svc::list_delete(&root, &id, &expected, Utc::now())
}

#[tauri::command]
pub fn reminder_report(
    state: State<'_, AppState>,
    reminder_id: String,
    action: CarryOverAction,
    new_due_date: Option<String>,
    expected: String,
    source_day: String,
    logical_day: String,
) -> Result<Reminder, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    machine_svc::apply_reminder_action(
        &root,
        &machine_id,
        &reminder_id,
        action,
        new_due_date.as_deref(),
        &expected,
        &source_day,
        &logical_day,
        Utc::now(),
    )
}

/// Mapping Tauri : `reminder_file_ref` ← `invoke("reminder_file_ref", { id })`
///
/// Lecture seule : l'UI récupère le hash courant pour le fournir à
/// `reminder_delete`, sans dépendre d'une révision de `config.json`.
#[tauri::command]
pub fn reminder_file_ref(state: State<'_, AppState>, id: String) -> Result<FileRef, DayaliError> {
    let (root, _) = vault_ids(&state)?;
    svc::get_file_ref(&root, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn reminder_list_maps_camel_case_filter_to_rust_and_filters() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(svc::REMINDERS_DIR)).unwrap();
        let raw = serde_json::json!({
            "statuses": ["open"],
            "listIds": ["0199a1b2-7081-7c92-8d4e-5f6a7b8c9d0e"],
            "dueWithinDays": 0
        });
        let filter: RemindersFilter = serde_json::from_value(raw).unwrap();
        assert_eq!(filter.due_within_days, Some(0));
        assert_eq!(
            filter.list_ids.as_deref(),
            Some(["0199a1b2-7081-7c92-8d4e-5f6a7b8c9d0e".to_string()].as_slice())
        );
        let result = reminder_list_from_root(
            root.path(),
            Some(&filter),
            chrono::DateTime::parse_from_rfc3339("2026-10-27T10:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            0,
            chrono_tz::UTC,
        )
        .unwrap();
        assert!(result.is_empty());
        let bad: RemindersFilter =
            serde_json::from_value(serde_json::json!({"dueWithinDays": -1})).unwrap();
        let error = reminder_list_from_root(root.path(), Some(&bad), Utc::now(), 0, chrono_tz::UTC)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
    }
}

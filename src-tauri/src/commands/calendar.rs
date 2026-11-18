//! Commandes calendrier (étape (c)) : agenda local + flux iCal.
//! Correspondant aux commandes `IpcApi` : `calendar_list`, `calendar_save`,
//! `calendar_delete`, `calendar_import_feed`.

use chrono::Utc;
use tauri::State;

use super::time_zone;
use crate::app_state::AppState;
use crate::commands::vault_ids;
use crate::error::DayaliError;
use crate::models::calendar::{CalendarListResult, LocalCalendarEvent};
use crate::models::common::FileRef;
use crate::services::calendar as svc;

/// Erreur unique des commandes non encore implémentées (temps 2).
fn unsupported(operation: &str) -> DayaliError {
    DayaliError::unsupported(format!(
        "{operation} n'est pas encore implémentée : agenda local et flux iCal en lecture seule prévus au temps 2."
    ))
}

/// Corps pur de `calendar_import_feed` : import d'un flux iCal (temps 2).
fn import_feed_stub() -> Result<crate::models::calendar::FeedStatus, DayaliError> {
    Err(unsupported("calendar_import_feed"))
}

/// Mapping Tauri : `calendar_list` ← `invoke("calendar_list", { from, to })`
#[tauri::command]
pub fn calendar_list(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<CalendarListResult, DayaliError> {
    let (root, _) = vault_ids(&state)?;
    calendar_list_from_root(
        &root,
        &time_zone(&state).to_string(),
        &from,
        &to,
        time_zone(&state),
    )
}

fn calendar_list_from_root(
    root: &std::path::Path,
    fallback_tz: &str,
    from: &str,
    to: &str,
    display_tz: chrono_tz::Tz,
) -> Result<CalendarListResult, DayaliError> {
    let (items, warnings) = svc::list_window(root, fallback_tz, from, to, display_tz)?;
    Ok(CalendarListResult { items, warnings })
}

/// Mapping Tauri : `calendar_save` ← `invoke("calendar_save", { event, expected? })`
#[tauri::command]
pub fn calendar_save(
    state: State<'_, AppState>,
    event: LocalCalendarEvent,
    expected: Option<String>,
) -> Result<LocalCalendarEvent, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    let fallback_tz = time_zone(&state).to_string();
    svc::save(
        &root,
        event,
        expected.as_deref(),
        &machine_id,
        Utc::now(),
        &fallback_tz,
    )
}

/// Mapping Tauri : `calendar_delete` ← `invoke("calendar_delete", { eventId, expected })`
#[tauri::command]
pub fn calendar_delete(
    state: State<'_, AppState>,
    event_id: String,
    expected: String,
) -> Result<(), DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, _) = vault_ids(&state)?;
    svc::delete(&root, &event_id, &expected, Utc::now())
}

/// Mapping Tauri : `calendar_file_ref` ← `invoke("calendar_file_ref", { id })`
#[tauri::command]
pub fn calendar_file_ref(state: State<'_, AppState>, id: String) -> Result<FileRef, DayaliError> {
    let (root, _) = vault_ids(&state)?;
    svc::get_file_ref(&root, &id)
}

/// Mapping Tauri : `calendar_import_feed` ← `invoke("calendar_import_feed", { feedId, url })`
#[tauri::command]
pub fn calendar_import_feed(
    _state: State<'_, AppState>,
    _feed_id: String,
    _url: String,
) -> Result<crate::models::calendar::FeedStatus, DayaliError> {
    import_feed_stub()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn calendar_import_feed_stub_is_unsupported() {
        let error = import_feed_stub()
            .expect_err("calendar_import_feed ne doit jamais réussir au temps 2a");
        assert_eq!(error.code, ErrorCode::Unsupported);
    }

    #[test]
    fn calendar_list_maps_window_and_returns_items_and_warnings() {
        let root = tempfile::tempdir().unwrap();
        let result = calendar_list_from_root(
            root.path(),
            "UTC",
            "2026-10-27",
            "2026-10-27",
            chrono_tz::UTC,
        )
        .unwrap();
        assert!(result.items.is_empty());
        assert!(result.warnings.is_empty());
        assert!(serde_json::to_value(&result)
            .unwrap()
            .get("items")
            .is_some());
        assert!(serde_json::to_value(&result)
            .unwrap()
            .get("warnings")
            .is_some());
    }

    #[test]
    fn calendar_list_rejects_inverted_window() {
        let root = tempfile::tempdir().unwrap();
        let error = calendar_list_from_root(
            root.path(),
            "UTC",
            "2026-10-28",
            "2026-10-27",
            chrono_tz::UTC,
        )
        .expect_err("une fenêtre inversée doit être refusée");
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
    }
}

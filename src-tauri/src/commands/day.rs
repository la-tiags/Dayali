//! Commandes de journée logique (PLAN §5.10).
//!
//! L'instant est toujours injecté (`{ at }`) : les tests et l'UI peuvent fixer
//! l'horloge sans changer l'algorithme. `dayStartHour` vient de `config.json`,
//! l'état de `machines/<id>.json`, jamais de la configuration.

use tauri::State;

use crate::app_state::AppState;
use crate::commands::{parse_at, vault_context};
use crate::error::DayaliError;
use crate::models::day::DayState;
use crate::services::machine;

/// État de la journée logique courante.
#[tauri::command]
pub fn day_state_get(state: State<'_, AppState>) -> Result<DayState, DayaliError> {
    let (root, machine_id, day_start_hour, time_zone) = vault_context(&state)?;
    machine::day_state(
        &root,
        &machine_id,
        day_start_hour,
        time_zone,
        chrono::Utc::now(),
    )
}

/// Démarre la journée de `at` ; idempotent par journée logique et par machine.
#[tauri::command]
pub fn day_start(state: State<'_, AppState>, at: String) -> Result<DayState, DayaliError> {
    let _guard = state.lock_writes()?;
    let at = parse_at(&at)?;
    let (root, machine_id, day_start_hour, time_zone) = vault_context(&state)?;
    machine::day_start(&root, &machine_id, day_start_hour, time_zone, at)
}

/// Marque le message « il est tard » comme affiché pour la journée de `at`.
#[tauri::command]
pub fn day_mark_late_night_shown(
    state: State<'_, AppState>,
    at: String,
) -> Result<DayState, DayaliError> {
    let _guard = state.lock_writes()?;
    let at = parse_at(&at)?;
    let (root, machine_id, day_start_hour, time_zone) = vault_context(&state)?;
    machine::mark_late_night_shown(&root, &machine_id, day_start_hour, time_zone, at)
}

//! Commandes de configuration du vault (`config.json`).

use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::vault_ids;
use crate::error::DayaliError;
use crate::models::config::ConfigSnapshot;
use crate::services::config;

/// Lit `config.json` et sa révision (aucune création implicite).
#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> Result<ConfigSnapshot, DayaliError> {
    let (root, _) = vault_ids(&state)?;
    config::snapshot(&root)
}

/// Applique un patch après vérification stricte de `expectedRevision`.
#[tauri::command]
pub fn config_patch(
    state: State<'_, AppState>,
    patch: Value,
    expected_revision: String,
) -> Result<ConfigSnapshot, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, _) = vault_ids(&state)?;
    config::patch(&root, &patch, &expected_revision)
}

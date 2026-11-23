//! Commandes d'information sur l'application (lecture seule).

use tauri::State;

use crate::app_state::AppState;
use crate::error::DayaliError;
use crate::models::common::AppPaths;

/// Dossiers applicatifs résolus par Tauri (diagnostic, jamais utilisés par l'UI
/// pour construire un chemin de fichier).
#[tauri::command]
pub fn app_paths(state: State<'_, AppState>) -> Result<AppPaths, DayaliError> {
    Ok(state.paths.clone())
}

/// Version de l'application (issue de `Cargo.toml`).
#[tauri::command]
pub fn app_version(state: State<'_, AppState>) -> Result<String, DayaliError> {
    Ok(state.app_version().to_string())
}

/// Couleur d'accent choisie dans le système, ou `null` si la plateforme ne
/// l'expose pas (l'UI masque alors l'option « suivre la couleur du système »).
#[tauri::command]
pub fn system_accent_color() -> Result<Option<String>, DayaliError> {
    Ok(crate::services::system_accent::read_accent_color())
}

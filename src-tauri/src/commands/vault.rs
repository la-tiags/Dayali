//! Commandes d'ouverture, de création et d'information du vault.

use chrono::Utc;
use tauri::State;

use crate::app_state::AppState;
use crate::error::DayaliError;
use crate::models::common::VaultInfo;
use crate::services::vault;

/// Ouvre un vault existant. Le dossier choisi EST la racine du vault.
///
/// Idempotent : un vault déjà initialisé n'est jamais réécrit. Met à jour
/// `machine.json` hors vault avec le même `machineId`.
#[tauri::command]
pub fn vault_open(state: State<'_, AppState>, path: String) -> Result<VaultInfo, DayaliError> {
    let _guard = state.lock_writes()?;
    let (open, local) = vault::open(&state, &path, Utc::now())?;
    let info = open.info();
    state.set_local(local)?;
    state.replace_vault(Some(open))?;
    Ok(info)
}

/// Crée `<parentPath>/<name>/` puis l'ouvre comme vault.
///
/// Même verrou et même mise à jour d'état que `vault_open`. Un dossier cible
/// non vide est refusé sans modification : c'est `vault_open` qui sert à ouvrir
/// un vault existant.
#[tauri::command]
pub fn vault_create(
    state: State<'_, AppState>,
    parent_path: String,
    name: String,
) -> Result<VaultInfo, DayaliError> {
    let _guard = state.lock_writes()?;
    let (open, local) = vault::create(&state, &parent_path, &name, Utc::now())?;
    let info = open.info();
    state.set_local(local)?;
    state.replace_vault(Some(open))?;
    Ok(info)
}

/// Ferme le vault actif.
#[tauri::command]
pub fn vault_close(state: State<'_, AppState>) -> Result<(), DayaliError> {
    let _guard = state.lock_writes()?;
    vault::close(&state)
}

/// Informations du vault actif, révision de `config.json` recalculée.
#[tauri::command]
pub fn vault_info(state: State<'_, AppState>) -> Result<VaultInfo, DayaliError> {
    vault::info(&state)
}

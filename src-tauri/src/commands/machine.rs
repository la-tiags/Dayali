//! Commandes d'identité et d'état local de la machine.

use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::vault_ids;
use crate::error::DayaliError;
use crate::models::machine::LocalState;
use crate::models::machine_local::MachineLocal;
use crate::services::machine;

/// Lit `machine.json` hors vault (identité + dernier vault). Ne modifie rien.
#[tauri::command]
pub fn machine_local_get(state: State<'_, AppState>) -> Result<MachineLocal, DayaliError> {
    machine::read_local(state.local_path()).map(|(local, _)| local)
}

/// `localState` du fichier machine du vault courant.
#[tauri::command]
pub fn machine_local_state_get(
    state: State<'_, AppState>,
) -> Result<LocalState, DayaliError> {
    let (root, machine_id) = vault_ids(&state)?;
    let (machine, _) = machine::read_vault_machine(&root, &machine_id)?;
    Ok(machine.local_state)
}

/// Patch de `localState` avec précondition sur le hash du fichier machine.
#[tauri::command]
pub fn machine_local_state_patch(
    state: State<'_, AppState>,
    patch: Value,
    expected_revision: String,
) -> Result<LocalState, DayaliError> {
    let _guard = state.lock_writes()?;
    let (root, machine_id) = vault_ids(&state)?;
    let (local, _) =
        machine::patch_local_state(&root, &machine_id, &patch, &expected_revision)?;
    Ok(local)
}

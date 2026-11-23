//! Commandes de la photo d'accueil Unsplash.
//!
//! La clé est celle de l'application, compilée dans le binaire : l'utilisateur
//! n'a rien à configurer et elle ne traverse jamais l'IPC. Sans clé (build
//! local), la commande renvoie `None` et l'UI garde la photo embarquée.
//!
//! L'historique des photos déjà affichées vit dans le vault
//! (`home-photos/<machineId>.json`) : seuls des identifiants et des dates.

use std::path::Path;

use serde::Deserialize;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::vault_ids;
use crate::error::DayaliError;
use crate::services::home_photo_history;
use crate::services::home_photos::{self, HomePhoto};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePhotoInput {
    pub logical_date: String,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePhotoSeenInput {
    pub id: String,
    pub logical_date: String,
}

#[tauri::command]
pub async fn home_photo_unsplash(
    state: State<'_, AppState>,
    input: HomePhotoInput,
) -> Result<Option<HomePhoto>, DayaliError> {
    let vault = vault_ids(&state).ok();
    home_photos::daily(
        Path::new(&state.paths.data_dir),
        vault
            .as_ref()
            .map(|(root, machine_id)| (root.as_path(), machine_id.as_str())),
        &input.logical_date,
        input.query.as_deref(),
    )
    .await
}

/// Identifiants des photos déjà affichées (toutes machines), du plus ancien au plus récent.
/// Liste vide si aucun vault n'est ouvert.
#[tauri::command]
pub fn home_photo_seen_list(state: State<'_, AppState>) -> Result<Vec<String>, DayaliError> {
    Ok(match vault_ids(&state) {
        Ok((root, _)) => home_photo_history::seen_ids(&root),
        Err(_) => Vec::new(),
    })
}

/// Note qu'une photo (choisie côté interface) est affichée ce jour-là.
#[tauri::command]
pub fn home_photo_seen_record(
    state: State<'_, AppState>,
    input: HomePhotoSeenInput,
) -> Result<(), DayaliError> {
    let (root, machine_id) = vault_ids(&state)?;
    home_photo_history::record(&root, &machine_id, &input.id, &input.logical_date)
}

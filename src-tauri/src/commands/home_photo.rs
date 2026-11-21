//! Commande de la photo d'accueil Unsplash.
//!
//! La clé est celle de l'application, compilée dans le binaire : l'utilisateur
//! n'a rien à configurer et elle ne traverse jamais l'IPC. Sans clé (build
//! local), la commande renvoie `None` et l'UI garde la photo embarquée.

use serde::Deserialize;
use tauri::State;

use crate::app_state::AppState;
use crate::error::DayaliError;
use crate::services::home_photos::{self, HomePhoto};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePhotoInput {
    pub logical_date: String,
    #[serde(default)]
    pub query: Option<String>,
}

#[tauri::command]
pub async fn home_photo_unsplash(
    state: State<'_, AppState>,
    input: HomePhotoInput,
) -> Result<Option<HomePhoto>, DayaliError> {
    home_photos::daily(
        std::path::Path::new(&state.paths.data_dir),
        &input.logical_date,
        input.query.as_deref(),
    )
    .await
}

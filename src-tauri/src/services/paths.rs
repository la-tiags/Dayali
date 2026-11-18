//! Dossiers applicatifs hors vault (PLAN §4.10).
//!
//! Tous les chemins viennent des API Tauri (`app_config_dir`, `app_data_dir`,
//! `app_cache_dir`, `app_log_dir`) : aucun chemin n'est codé en dur. Le seul
//! fichier d'identité hors vault de l'étape (a) est `machine.json`, dans le
//! dossier de configuration.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::AppPaths;
use crate::vault::paths;

/// Nom du fichier d'identité de l'installation (jamais synchronisé).
pub const MACHINE_LOCAL_FILENAME: &str = "machine.json";

fn absolute_display(path: &Path) -> String {
    paths::normalize_absolute_display(path)
}

fn tauri_error(error: tauri::Error) -> DayaliError {
    DayaliError::new(
        ErrorCode::Tauri,
        format!("résolution des dossiers applicatifs impossible : {error}"),
    )
}

/// Résout les quatre dossiers applicatifs via Tauri.
pub fn app_paths(app: &AppHandle) -> Result<AppPaths, DayaliError> {
    let resolver = app.path();
    let config_dir = resolver.app_config_dir().map_err(tauri_error)?;
    let data_dir = resolver.app_data_dir().map_err(tauri_error)?;
    let cache_dir = resolver.app_cache_dir().map_err(tauri_error)?;
    let log_dir = resolver.app_log_dir().map_err(tauri_error)?;

    Ok(AppPaths {
        config_dir: absolute_display(&config_dir),
        data_dir: absolute_display(&data_dir),
        cache_dir: absolute_display(&cache_dir),
        log_dir: absolute_display(&log_dir),
    })
}

/// Crée les dossiers applicatifs au démarrage (idempotent).
pub fn ensure_app_dirs(app_paths: &AppPaths) -> Result<(), DayaliError> {
    for dir in [
        &app_paths.config_dir,
        &app_paths.data_dir,
        &app_paths.cache_dir,
        &app_paths.log_dir,
    ] {
        paths::ensure_dir(Path::new(dir))?;
    }
    Ok(())
}

/// Chemin de `machine.json` hors vault.
pub fn machine_local_path(app_paths: &AppPaths) -> PathBuf {
    Path::new(&app_paths.config_dir).join(MACHINE_LOCAL_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_file_lives_in_the_config_directory() {
        let app_paths = AppPaths {
            config_dir: "/Users/tiago/Library/Application Support/app.dayali.desktop".to_string(),
            data_dir: "/Users/tiago/Library/Application Support/app.dayali.desktop".to_string(),
            cache_dir: "/Users/tiago/Library/Caches/app.dayali.desktop".to_string(),
            log_dir: "/Users/tiago/Library/Logs/app.dayali.desktop".to_string(),
        };
        assert_eq!(
            machine_local_path(&app_paths),
            PathBuf::from(
                "/Users/tiago/Library/Application Support/app.dayali.desktop/machine.json"
            )
        );
    }

    #[test]
    fn display_paths_have_no_trailing_separator() {
        assert_eq!(absolute_display(Path::new("/tmp/dayali/")), "/tmp/dayali");
        assert_eq!(absolute_display(Path::new("/")), "/");
    }
}

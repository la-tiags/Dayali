//! Dayali — bibliothèque Tauri (PLAN §5.6, §6(a)).
//!
//! Surface volontairement minimale : aucune commande générique de fichiers,
//! aucun plugin `fs`, aucun watcher, aucun verrou inter-processus. Les seules
//! écritures exposées sont `vault_open`, `vault_create`, `config_patch`,
//! `day_start`, `day_mark_late_night_shown`, `machine_local_state_patch` et les
//! commandes `reminder_*` (déléguées à `services::reminders`).

pub mod app_state;
pub mod commands;
pub mod error;
pub mod models;
pub mod services;
pub mod vault;

use chrono::Utc;
use tauri::Manager;

use crate::app_state::{AppState, LocalSlot};
use crate::error::{DayaliError, ErrorCode};
use crate::models::machine::{Arch, MachineProfile, Platform};
use crate::services::{day as svc_day, machine, paths};

fn machine_profile() -> MachineProfile {
    let platform = if cfg!(target_os = "macos") {
        Platform::Macos
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    };
    let arch = if cfg!(target_arch = "aarch64") {
        Arch::Arm64
    } else if cfg!(target_arch = "x86_64") {
        Arch::X8664
    } else {
        Arch::Other
    };

    let hostname = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= 255);
    let fallback_name = match platform {
        Platform::Macos => "Mac",
        Platform::Windows => "PC Windows",
        Platform::Linux => "PC Linux",
    };
    let name = hostname
        .as_deref()
        .map(|value| value.chars().take(64).collect())
        .unwrap_or_else(|| fallback_name.to_string());

    MachineProfile {
        name,
        platform,
        arch,
        hostname,
        os_version: None,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Fuseau IANA de la machine, validé ; repli `UTC` si la plateforme n'en donne
/// aucun. Le repli est signalé à l'UI, jamais appliqué en silence à un instant.
fn detect_time_zone() -> String {
    match iana_time_zone::get_timezone() {
        Ok(time_zone) if svc_day::parse_time_zone(&time_zone).is_some() => time_zone,
        _ => "UTC".to_string(),
    }
}

fn bootstrap(app: &tauri::AppHandle) -> Result<AppState, DayaliError> {
    let app_paths = paths::app_paths(app)?;
    paths::ensure_app_dirs(&app_paths)?;
    let local_path = paths::machine_local_path(&app_paths);

    let local = match machine::load_or_init_local(&local_path, Utc::now()) {
        Ok((local, _)) => LocalSlot::Ready(local),
        // Une corruption est conservée et remontée à chaque lecture ; elle ne
        // justifie jamais une réécriture silencieuse.
        Err(error) if error.code == ErrorCode::SchemaInvalid => LocalSlot::Broken(error),
        Err(error) => return Err(error),
    };

    Ok(AppState::new(
        app_paths,
        local_path,
        machine_profile(),
        detect_time_zone(),
        local,
    ))
}

/// Point d'entrée commun au binaire et aux tests d'intégration Tauri.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let state = bootstrap(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_open,
            commands::vault::vault_create,
            commands::vault::vault_close,
            commands::vault::vault_info,
            commands::config::config_get,
            commands::config::config_patch,
            commands::machine::machine_local_get,
            commands::machine::machine_local_state_get,
            commands::machine::machine_local_state_patch,
            commands::day::day_state_get,
            commands::day::day_start,
            commands::day::day_mark_late_night_shown,
            commands::reminder::reminder_list,
            commands::reminder::reminder_save,
            commands::reminder::reminder_delete,
            commands::reminder::reminder_file_ref,
            commands::calendar::calendar_list,
            commands::calendar::calendar_save,
            commands::calendar::calendar_delete,
            commands::calendar::calendar_file_ref,
            commands::calendar::calendar_feed_list,
            commands::calendar::calendar_feed_add,
            commands::calendar::calendar_feed_remove,
            commands::calendar::calendar_feed_refresh,
            commands::reminder::reminder_list_defs,
            commands::reminder::reminder_list_save,
            commands::reminder::reminder_list_delete,
            commands::reminder::reminder_report,
            commands::home_photo::home_photo_unsplash,
            commands::home_photo::home_photo_seen_list,
            commands::home_photo::home_photo_seen_record,
            commands::app::app_paths,
            commands::app::app_version,
            commands::app::system_accent_color,
        ])
        .run(tauri::generate_context!())
        .expect("échec du lancement de Dayali");
}

//! Commandes Tauri nommées de l'étape (a) (PLAN §5.6).
//!
//! Aucune commande générique `read_file`/`write_file` : chaque commande valide
//! ses entrées et délègue à un service testable. Les verrous d'écriture sont
//! pris ici, jamais dans un service, pour que les tests Rust restent purs.

pub mod app;
pub mod calendar;
pub mod config;
pub mod day;
pub mod machine;
pub mod reminder;
pub mod vault;

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use crate::app_state::AppState;
use crate::error::DayaliError;
use crate::models::common::parse_iso;
use crate::services::{config as svc_config, day as svc_day};

/// Racine canonique et identité de la machine pour le vault ouvert.
pub(crate) fn vault_ids(state: &AppState) -> Result<(PathBuf, String), DayaliError> {
    state.with_vault(|vault| Ok((vault.root.clone(), vault.machine_id.clone())))
}

/// Contexte nécessaire à la journée logique : config courante + fuseau machine.
pub(crate) fn vault_context(
    state: &AppState,
) -> Result<(PathBuf, String, u32, Tz), DayaliError> {
    let (root, machine_id) = vault_ids(state)?;
    let (config, _) = svc_config::read(&root)?;
    Ok((root, machine_id, config.day_start_hour, time_zone(state)))
}

/// Fuseau validé au démarrage ; repli `UTC` uniquement si la plateforme n'en a
/// fourni aucun (jamais de décalage silencieux d'un instant).
pub(crate) fn time_zone(state: &AppState) -> Tz {
    svc_day::parse_time_zone(&state.time_zone).unwrap_or_else(svc_day::fallback_time_zone)
}

/// Parse l'instant injecté par l'UI (`{ at }`), au format de contrat.
pub(crate) fn parse_at(value: &str) -> Result<DateTime<Utc>, DayaliError> {
    parse_iso(value).map_err(|_| {
        DayaliError::schema_invalid(
            "/at",
            "instant attendu : RFC 3339 UTC avec suffixe Z (ex. 2026-10-27T10:00:00.000Z)",
        )
    })
}

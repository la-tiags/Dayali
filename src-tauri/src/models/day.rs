//! État de journée dérivé, non persisté (PLAN §5.10).
//!
//! `lastDayStartDate`/`lastDayStartedAt`/`lateNightShownFor` sont lus dans
//! `.dayali/machines/<machineId>.json#localState`, **jamais** dans `config.json`
//! (décision du 27/10/2026, SPEC §6).

use serde::{Deserialize, Serialize};

use crate::models::reminders::Reminder;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayState {
    pub logical_day: String,
    pub day_start_hour: u32,
    pub started: bool,
    pub last_day_started_at: Option<String>,
    pub late_night_shown_for: Option<String>,
    /// Restes non traités : recalculés à la lecture, jamais persistés
    /// (PLAN §4.2, SPEC §6). Un rappel est un reste quand il est `open`, a une
    /// échéance ≤ veille logique et n'a aucune entrée `reminderHistory` pour cette
    /// même `sourceDay`.
    pub carry_over_candidates: Vec<Reminder>,
    /// Avertissements de lecture des rappels pour le calcul des restes :
    /// un fichier illisible est ignoré (jamais réécrit, déplacé ni supprimé) et
    /// signalé ici par son identifiant et le code d'erreur. Recalculés à la
    /// lecture, jamais persistés ; vide quand tous les fichiers sont lisibles.
    pub carry_over_warnings: Vec<String>,
}

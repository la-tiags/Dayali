//! Modèles Rappels V1.
//!
//! Source de vérité : `docs/schemas/reminder.schema.json`,
//! `docs/schemas/reminder-list.schema.json` et les types TypeScript
//! `Reminder`, `ReminderRecurrence`, `ReminderList`, `RemindersFilter`
//! (`src/lib/contracts/types.ts`).
//!
//! Règles de sérialisation, sans exception :
//!  - `camelCase` à la frontière JSON ;
//!  - `additionalProperties: false` → `deny_unknown_fields` (un fichier avec une
//!    clé inconnue est refusé, jamais réécrit en silence) ;
//!  - tous les champs nullables du schéma sont **présents** et valent `null`
//!    quand ils sont absents (pas de `skip_serializing_if`) : le fichier doit
//!    contenir exactement les clés du schéma.
//!
//! La validation métier (bornes, cohérences, existence de `listId`) vit dans
//! `services::reminders`, avant toute écriture.

use serde::{Deserialize, Serialize};

/// Statut d'un rappel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderStatus {
    Open,
    Done,
    Cancelled,
    Abandoned,
    #[serde(serialize_with = "serialize_unknown")]
    Unknown(String),
}

fn serialize_unknown<S>(value: &String, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(value)
}

impl<'de> Deserialize<'de> for ReminderStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "open" => Self::Open,
            "done" => Self::Done,
            "cancelled" => Self::Cancelled,
            "abandoned" => Self::Abandoned,
            _ => Self::Unknown(value),
        })
    }
}

/// Fréquence d'une récurrence (forme V2, jamais écrite en V1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecurrenceFrequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// Récurrence d'un rappel — **réservée V2**.
///
/// Le reader V1 tolère un objet existant (il ne le détruit pas), mais le writer
/// V1 refuse toute récurrence non nulle (`E_UNSUPPORTED`) au lieu de la
/// supprimer en silence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRecurrence {
    pub frequency: RecurrenceFrequency,
    pub interval: i32,
    pub weekdays: Vec<i32>,
    pub until_date: Option<String>,
    pub count: Option<i32>,
    pub time_zone: String,
    /// Extensions from newer schema versions are retained byte-for-byte as
    /// structured JSON and written back by the preserving writer.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Rappel persisté dans `reminders/<reminderId>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub schema_version: u32,
    pub id: String,
    pub list_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub status: ReminderStatus,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub due_time_zone: Option<String>,
    pub project_id: Option<String>,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub abandoned_at: Option<String>,
    pub recurrence: Option<ReminderRecurrence>,
    pub sort_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub machine_id: String,
    /// Forward-compatible top-level extensions retained across edits.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Liste de rappels persistée dans `reminders/lists/<listId>.json`.
///
/// « Ma journée » n'est **pas** une liste stockée : c'est un filtre calculé
/// (`status=open` + échéance ≤ jour logique).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderList {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub order: i32,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub machine_id: String,
}

/// Filtre de rappels V1 (vue enregistrée, « Ma journée », widget).
///
/// `dueWithinDays` absent = pas de filtre d'échéance ; `0` = échéance ≤ jour
/// logique, retards inclus ; `n > 0` = fenêtre `[jour-(n-1), jour]`.
///
/// Le filtre n'est pas un fichier persisté : les champs inconnus sont ignorés
/// (une vue peut porter des options d'UI), contrairement aux rappels eux-mêmes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemindersFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statuses: Option<Vec<ReminderStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_within_days: Option<i32>,
}

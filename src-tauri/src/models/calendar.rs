//! Modèles Agenda V1 : `LocalCalendarEvent` (persisté `calendar/<eventId>.ics`)
//! vs `FeedOccurrence` (flux externe, non persisté).
//!
//! Source de vérité : `docs/schemas/calendar-event.schema.json` (§4.7, §5.10) et
//! `docs/PLAN.md` §4.7.1. Le schéma JSON valide **uniquement** les événements
//! locaux ; une occurrence de flux n'est jamais validée par ce schéma.
//!
//! Invariant : `calendar-event.id` == stem du fichier `calendar/<id>.ics` == UID
//! sans suffixe (`<id>@dayali.local`).

use chrono::{DateTime, NaiveDate, Utc};
#[cfg(test)]
use chrono::TimeZone;
use serde::{Deserialize, Serialize};

use crate::error::DayaliError;
use crate::models::common::{is_local_date, is_uuid, parse_iso};

/// Point temporel d'un événement : journée entière (`date`) ou date-time
/// (`dateTime` = instant UTC + `timeZone` = fuseau d'origine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EventTimePoint {
    /// Journée entière : date civile `YYYY-MM-DD` (DTSTART/DTEND `VALUE=DATE`,
    /// DTEND exclusif).
    Date {
        date: String,
    },
    /// Horaire : instant UTC + fuseau d'origine (TZID / `X-DAYALI-TZID`).
    DateTime {
        #[serde(rename = "dateTime")]
        date_time: DateTime<Utc>,
        #[serde(rename = "timeZone")]
        time_zone: String,
    },
}

impl EventTimePoint {
    /// Installe UTC RFC 3339 (`...Z`) à partir d'un point temporel.
    pub fn to_iso(&self) -> String {
        match self {
            EventTimePoint::Date { date } => date.clone(),
            EventTimePoint::DateTime { date_time, .. } => crate::models::common::to_iso(*date_time),
        }
    }

    /// Date civile du point temporel (journée entière ou date d'occurrence).
    pub fn date_only(&self) -> NaiveDate {
        match self {
            EventTimePoint::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap_or_default(),
            EventTimePoint::DateTime { date_time, .. } => date_time.with_timezone(&Utc).date_naive(),
        }
    }
}

/// État de confirmation d'un événement (`STATUS` ICS, valeurs RFC 5545).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventStatus {
    Confirmed,
    Tentative,
    Cancelled,
}

impl EventStatus {
    pub fn from_ics(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "TENTATIVE" => EventStatus::Tentative,
            "CANCELLED" => EventStatus::Cancelled,
            _ => EventStatus::Confirmed,
        }
    }
}

/// Événement de calendrier **local**, persisté dans `calendar/<eventId>.ics`
/// (un fichier par événement, jamais partagé en écriture).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalCalendarEvent {
    /// UUID, identique au stem du fichier `calendar/<id>.ics`.
    pub id: String,
    /// UID ICS stable : `<id>@dayali.local`.
    pub uid: String,
    /// `"local"` en V1 ; un `feedId` en V2 (les événements de flux ne sont pas écrits).
    pub calendar_id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub all_day: bool,
    pub start: EventTimePoint,
    pub end: EventTimePoint,
    pub project_id: Option<String>,
    pub machine_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sequence: i32,
    pub status: EventStatus,
}

impl LocalCalendarEvent {
    pub fn new(
        id: &str,
        uid: &str,
        title: &str,
        all_day: bool,
        start: EventTimePoint,
        end: EventTimePoint,
        status: EventStatus,
        sequence: i32,
        created_at: &str,
        updated_at: &str,
        project_id: Option<String>,
        machine_id: Option<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            uid: uid.to_string(),
            calendar_id: "local".to_string(),
            title: title.to_string(),
            description: None,
            location: None,
            all_day,
            start,
            end,
            project_id,
            machine_id,
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
            sequence,
            status,
        }
    }

    /// Vérifie les invariants du modèle local (PLAN §4.7, `calendar-event.schema.json`).
    pub fn validate(&self) -> Result<(), DayaliError> {
        let base = crate::error::DayaliError::schema_invalid("/", "événement local invalide");
        if !is_uuid(&self.id) {
            return Err(base.clone().with_details(serde_json::json!({ "field": "id" })));
        }
        if self.uid != format!("{}@dayali.local", self.id) {
            return Err(base.clone().with_details(serde_json::json!({ "field": "uid" })));
        }
        if self.calendar_id != "local" {
            return Err(base.clone().with_details(serde_json::json!({ "field": "calendarId" })));
        }
        let title_len = self.title.chars().count();
        if title_len == 0 || title_len > 300 {
            return Err(base.clone().with_details(serde_json::json!({ "field": "title" })));
        }
        if let Some(description) = &self.description {
            if description.chars().count() > 20_000 {
                return Err(base.clone().with_details(serde_json::json!({ "field": "description" })));
            }
        }
        if let Some(location) = &self.location {
            if location.chars().count() > 500 {
                return Err(base.clone().with_details(serde_json::json!({ "field": "location" })));
            }
        }
        match (&self.start, &self.end) {
            (EventTimePoint::Date { date }, EventTimePoint::Date { date: end_date }) => {
                if !is_local_date(date) || !is_local_date(end_date) || end_date <= date {
                    return Err(base.clone().with_details(serde_json::json!({ "field": "end" })));
                }
            }
            (
                EventTimePoint::DateTime {
                    date_time: start,
                    ..
                },
                EventTimePoint::DateTime {
                    date_time: end,
                    ..
                },
            ) => {
                if end <= start {
                    return Err(base.clone().with_details(serde_json::json!({ "field": "end" })));
                }
            }
            _ => {
                return Err(base.clone().with_details(serde_json::json!({ "field": "start" })));
            }
        }
        if !self.all_day {
            if let EventTimePoint::DateTime { time_zone, .. } = &self.start {
                if !crate::models::common::is_time_zone_name(time_zone) {
                    return Err(
                        crate::error::DayaliError::schema_invalid("/", "événement local : fuseau invalide")
                            .with_details(serde_json::json!({ "field": "start.timeZone" })),
                    );
                }
            }
        }
        parse_iso(&self.created_at)?;
        parse_iso(&self.updated_at)?;
        if self.sequence < 0 {
            return Err(base.with_details(serde_json::json!({ "field": "sequence" })));
        }
        Ok(())
    }
}

/// Résultat de `calendar_list` : items + avertissements sur fichiers illisibles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListResult {
    pub items: Vec<CalendarItem>,
    pub warnings: Vec<String>,
}

/// Occurrence **émettant** d'un flux externe : `start`/`end` décrivent l'occurrence
/// effective (après application d'un `RECURRENCE-ID`), `occurrenceStart` conserve le
/// début d'origine. Jamais persistée.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOccurrence {
    /// `feedId`, jamais `"local"`.
    pub calendar_id: String,
    /// UID d'origine du fournisseur (format libre).
    pub uid: String,
    /// UID de la série (`RRULE`/`EXDATE`/`RECURRENCE-ID`), = uid pour une occurrence non récurrente.
    pub series_uid: String,
    /// Début d'origine de l'occurrence, avant application de l'override.
    pub occurrence_start: EventTimePoint,
    pub is_recurring: bool,
    pub read_only: bool,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub all_day: bool,
    /// Occurrence effective (peut être déplacée par un `RECURRENCE-ID`).
    pub start: EventTimePoint,
    /// Fin exclusive de l'occurrence effective.
    pub end: EventTimePoint,
    pub status: EventStatus,
    /// Toujours `null` en V1 : un flux n'est pas rattaché à un projet.
    pub project_id: Option<String>,
    /// Nom du calendrier abonné (renseigné au listage, jamais lu depuis le flux).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_name: Option<String>,
    /// Couleur `#RRGGBB` choisie pour le calendrier abonné.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_color: Option<String>,
}

impl FeedOccurrence {
    pub fn validate(&self) -> Result<(), DayaliError> {
        if self.calendar_id.is_empty() || self.calendar_id == "local" {
            return Err(
                crate::error::DayaliError::schema_invalid("/", "occurrence de flux : calendarId invalide")
                    .with_details(serde_json::json!({ "field": "calendarId" })),
            );
        }
        if !self.read_only {
            return Err(
                crate::error::DayaliError::schema_invalid("/", "occurrence de flux : lecture seule")
                    .with_details(serde_json::json!({ "field": "readOnly" })),
            );
        }
        if self.start.date_only() > self.end.date_only() {
            return Err(
                crate::error::DayaliError::schema_invalid("/", "occurrence de flux : fin avant début")
                    .with_details(serde_json::json!({ "field": "end" })),
            );
        }
        if self.title.chars().count() == 0 {
            return Err(
                crate::error::DayaliError::schema_invalid("/", "occurrence de flux : titre requis")
                    .with_details(serde_json::json!({ "field": "title" })),
            );
        }
        Ok(())
    }
}

/// Type d'affichage commun : événement local persisté vs occurrence de flux éphémère.
///
/// Sérialisé en JSON sans délimiteur de variant : un `LocalCalendarEvent` se sérialise
/// avec ses champs métier, une `FeedOccurrence` avec ses champs de flux (dont
/// `readOnly: true`). Le frontend distingue via la présence de `id` / `readOnly`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum CalendarItem {
    Local(LocalCalendarEvent),
    Feed(FeedOccurrence),
}

/// Statut de lecture d'un flux iCal (cache hors vault, PLAN §5.10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub feed_id: String,
    pub url: String,
    pub last_fetched_at: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub events_count: usize,
    pub error: Option<String>,
}

/// Confidentialité déclarée d'un calendrier abonné. Un calendrier privé a une adresse secrète :
/// tant que le coffre chiffré n'existe pas, elle est stockée **en clair** sur cette machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedVisibility {
    Public,
    Private,
}

/// Abonnement à un calendrier iCal par URL (propre à la machine, hors vault).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSubscription {
    pub id: String,
    pub name: String,
    pub url: String,
    pub visibility: FeedVisibility,
    #[serde(default)]
    pub color: Option<String>,
    pub added_at: String,
}

/// Abonnement + état de la dernière synchronisation, tel que l'affiche l'interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarFeed {
    pub id: String,
    pub name: String,
    pub url: String,
    pub visibility: FeedVisibility,
    pub color: Option<String>,
    pub added_at: String,
    pub last_fetched_at: Option<String>,
    pub events_count: usize,
    pub error: Option<String>,
}

/// Entrée de `calendar_feed_add`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAddInput {
    pub name: String,
    pub url: String,
    pub visibility: FeedVisibility,
    #[serde(default)]
    pub color: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_time_point_round_trips_iso_datetime() {
        let point = EventTimePoint::DateTime {
            date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 27, 8, 30, 0).unwrap(),
            time_zone: "Europe/Paris".to_string(),
        };
        assert_eq!(point.to_iso(), "2026-10-27T08:30:00.000Z");
        assert_eq!(point.date_only().to_string(), "2026-10-27");
    }

    #[test]
    fn local_event_requires_local_calendar_and_valid_bounds() {
        let valid = LocalCalendarEvent::new(
            "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d",
            "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d@dayali.local",
            "Point projet Dayali",
            false,
            EventTimePoint::DateTime {
                date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 27, 8, 30, 0).unwrap(),
                time_zone: "Europe/Paris".to_string(),
            },
            EventTimePoint::DateTime {
                date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 27, 9, 30, 0).unwrap(),
                time_zone: "Europe/Paris".to_string(),
            },
            EventStatus::Confirmed,
            2,
            "2026-10-25T14:00:00.000Z",
            "2026-10-26T18:45:00.000Z",
            None,
            None,
        );
        assert!(valid.validate().is_ok());

        let mut inverted = valid.clone();
        inverted.end = EventTimePoint::DateTime {
            date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 27, 8, 0, 0).unwrap(),
            time_zone: "Europe/Paris".to_string(),
        };
        assert!(inverted.validate().is_err());
    }

    #[test]
    fn event_time_point_json_matches_contract() {
        let date = EventTimePoint::Date {
            date: "2026-10-27".to_string(),
        };
        let date_json = serde_json::to_string(&date).unwrap();
        assert_eq!(date_json, r#"{"date":"2026-10-27"}"#);
        let date_back: EventTimePoint = serde_json::from_str(&date_json).unwrap();
        assert_eq!(date_back, date);

        let dt = EventTimePoint::DateTime {
            date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 27, 8, 30, 0).unwrap(),
            time_zone: "Europe/Paris".to_string(),
        };
        let dt_json = serde_json::to_string(&dt).unwrap();
        assert_eq!(dt_json, r#"{"dateTime":"2026-10-27T08:30:00Z","timeZone":"Europe/Paris"}"#);
        let dt_back: EventTimePoint = serde_json::from_str(&dt_json).unwrap();
        assert_eq!(dt_back, dt);

        // Externally-tagged shape must NOT be produced.
        assert!(!date_json.contains("\"Date\""));
        assert!(!dt_json.contains("\"DateTime\""));
    }

    #[test]
    fn feed_occurrence_is_read_only_and_never_local() {
        let occurrence = FeedOccurrence {
            calendar_id: "feed-google-personal@group.calendar.google.com".to_string(),
            uid: "3f8a1b2c-1111-2222-3333-444455556666@group.calendar.google.com".to_string(),
            series_uid: "3f8a1b2c-1111-2222-3333-444455556666@group.calendar.google.com".to_string(),
            occurrence_start: EventTimePoint::Date {
                date: "2026-10-29".to_string(),
            },
            is_recurring: true,
            read_only: true,
            title: "Point projet".to_string(),
            description: None,
            location: None,
            all_day: false,
            start: EventTimePoint::DateTime {
                date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 29, 8, 0, 0).unwrap(),
                time_zone: "Europe/Paris".to_string(),
            },
            end: EventTimePoint::DateTime {
                date_time: chrono::Utc.with_ymd_and_hms(2026, 10, 29, 9, 0, 0).unwrap(),
                time_zone: "Europe/Paris".to_string(),
            },
            status: EventStatus::Confirmed,
            project_id: None,
            calendar_name: None,
            calendar_color: None,
        };
        assert!(occurrence.validate().is_ok());
        assert!(occurrence.read_only);

        let local_feed = FeedOccurrence {
            calendar_id: "local".to_string(),
            ..occurrence.clone()
        };
        assert!(local_feed.validate().is_err());
    }
}

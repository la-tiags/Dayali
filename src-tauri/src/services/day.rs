//! Journée logique (PLAN §2.3, §6).
//!
//! Une **seule** fonction sert l'accueil, la fin de journée et le message
//! « il est tard » : `logicalDay(instant, dayStartHour, tz)` = date locale de
//! `instant - dayStartHour heures`. Les changements d'heure sont résolus par la
//! base IANA (`chrono-tz`), jamais par un décalage fixe.
//!
//! La fixture partagée `tests/fixtures/day-cases.json` verrouille cette
//! implémentation avec la version TypeScript (PLAN §1.7, §7.3).

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;

use crate::error::DayaliError;

/// Nombre maximal d'heures de décalage (0–23).
pub const MAX_DAY_START_HOUR: u32 = 23;

/// Résout un identifiant IANA. Un identifiant inconnu retombe sur `UTC` :
/// l'appelant (démarrage) doit avoir averti l'utilisateur, jamais décalé en
/// silence un instant (PLAN §2.3).
pub fn parse_time_zone(value: &str) -> Option<Tz> {
    // Seuls les identifiants IANA canoniques sont acceptés : soit "UTC", soit un
    // nom composé avec "/" (ex. "Europe/Paris"). Les abréviations ("CET",
    // "GMT+1") et les décalages fixes sont refusés (PLAN §2.3).
    if value != "UTC" && !value.contains('/') {
        return None;
    }
    value.parse::<Tz>().ok()
}

/// Fuseau de repli, utilisé uniquement quand la machine n'expose aucun fuseau
/// IANA valide.
pub fn fallback_time_zone() -> Tz {
    Tz::UTC
}

/// `logicalDay(instant, dayStartHour, tz)`.
///
/// On soustrait un nombre **fixe** d'heures à l'instant UTC, puis on lit la
/// date civile dans le fuseau demandé. C'est exact autour des changements
/// d'heure : la soustraction porte sur un instant, pas sur une heure locale.
pub fn logical_day(
    instant: DateTime<Utc>,
    day_start_hour: u32,
    time_zone: Tz,
) -> Result<NaiveDate, DayaliError> {
    if day_start_hour > MAX_DAY_START_HOUR {
        return Err(DayaliError::schema_invalid(
            "/dayStartHour",
            format!("dayStartHour hors 0–{MAX_DAY_START_HOUR}"),
        ));
    }
    let shifted = instant - Duration::hours(i64::from(day_start_hour));
    Ok(shifted.with_timezone(&time_zone).date_naive())
}

/// Variante `YYYY-MM-DD` de [`logical_day`].
pub fn logical_day_string(
    instant: DateTime<Utc>,
    day_start_hour: u32,
    time_zone: Tz,
) -> Result<String, DayaliError> {
    Ok(logical_day(instant, day_start_hour, time_zone)?
        .format("%Y-%m-%d")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::parse_iso;

    /// Fixture partagée TS/Rust : 11 cas, dont deux changements d'heure et deux
    /// années bissextiles.
    #[test]
    fn matches_shared_day_cases_fixture() {
        let raw = include_str!("../../../tests/fixtures/day-cases.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 11, "la fixture doit garder ses 11 cas");

        for case in cases {
            let id = case["id"].as_str().unwrap();
            let instant = parse_iso(case["instant"].as_str().unwrap()).unwrap();
            let time_zone_name = case["timeZone"].as_str().unwrap();
            let day_start_hour = case["dayStartHour"].as_u64().unwrap() as u32;
            let expected = case["expectedDate"].as_str().unwrap();
            let time_zone = parse_time_zone(time_zone_name)
                .unwrap_or_else(|| panic!("fuseau IANA inconnu dans le cas {id}"));

            let computed = logical_day_string(instant, day_start_hour, time_zone).unwrap();
            assert_eq!(computed, expected, "cas {id} ({time_zone_name})");
        }
    }

    #[test]
    fn rejects_out_of_range_day_start_hour() {
        let instant = parse_iso("2026-10-27T02:30:00.000Z").unwrap();
        let error = logical_day(instant, 24, Tz::Europe__Paris).unwrap_err();
        assert_eq!(error.details.unwrap()["path"], "/dayStartHour");
    }

    #[test]
    fn unknown_time_zone_is_not_silently_reinterpreted() {
        assert!(parse_time_zone("Europe/Paris").is_some());
        assert!(parse_time_zone("UTC").is_some());
        assert!(parse_time_zone("CET").is_none());
        assert_eq!(fallback_time_zone(), Tz::UTC);
    }
}

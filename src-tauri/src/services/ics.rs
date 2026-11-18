//! Stockage local `.ics` (SPEC §4, PLAN §4.7) : un événement par fichier.
//!
//! V1 temps 2a : uniquement les événements locaux (`calendar/<id>.ics`).
//! Aucun flux externe, aucune RRULE, aucun VTIMEZONE.

use chrono::{DateTime, NaiveDate, Utc};
use std::str::FromStr;
use icalendar::{
    Calendar, Component, DatePerhapsTime, Event, EventLike, EventStatus as IcsEventStatus, Property,
    ValueType,
};

use crate::error::DayaliError;
use crate::models::calendar::{EventStatus, EventTimePoint, LocalCalendarEvent};
use crate::models::common::{is_time_zone_name, parse_iso, to_iso};

/// Convertit un événement local en texte iCalendar (VCALENDAR 2.0).
pub fn to_ics(event: &LocalCalendarEvent) -> Result<String, DayaliError> {
    let mut calendar = Calendar::empty();
    calendar.append_property(Property::new("VERSION", "2.0"));
    calendar.append_property(Property::new("PRODID", "-//Dayali//Dayali V1//FR"));
    calendar.append_property(Property::new("CALSCALE", "GREGORIAN"));

    let mut ev = Event::new();
    ev.uid(&event.uid);

    let updated_at = parse_iso(&event.updated_at)?;
    ev.timestamp(updated_at);
    let created_at = parse_iso(&event.created_at)?;
    ev.created(created_at);
    ev.last_modified(updated_at);

    if event.sequence >= 0 {
        ev.sequence(event.sequence as u32);
    }

    let ics_status = match event.status {
        EventStatus::Confirmed => IcsEventStatus::Confirmed,
        EventStatus::Tentative => IcsEventStatus::Tentative,
        EventStatus::Cancelled => IcsEventStatus::Cancelled,
    };
    ev.status(ics_status);

    ev.summary(&event.title);
    if let Some(description) = &event.description {
        ev.description(description);
    }
    if let Some(location) = &event.location {
        ev.location(location);
    }

    if event.all_day {
        let start_date = match &event.start {
            EventTimePoint::Date { date } => date.clone(),
            _ => {
                return Err(DayaliError::schema_invalid(
                    "/start",
                    "événement toute la journée sans date",
                ))
            }
        };
        let end_date = match &event.end {
            EventTimePoint::Date { date } => date.clone(),
            _ => {
                return Err(DayaliError::schema_invalid(
                    "/end",
                    "événement toute la journée sans date",
                ))
            }
        };
        let start_ics = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
            .map_err(|_| DayaliError::schema_invalid("/start", "date invalide"))?
            .format("%Y%m%d")
            .to_string();
        let end_ics = NaiveDate::parse_from_str(&end_date, "%Y-%m-%d")
            .map_err(|_| DayaliError::schema_invalid("/end", "date invalide"))?
            .format("%Y%m%d")
            .to_string();
        ev.append_property(
            Property::new("DTSTART", start_ics)
                .add_parameter("VALUE", "DATE")
                .done(),
        );
        ev.append_property(
            Property::new("DTEND", end_ics)
                .add_parameter("VALUE", "DATE")
                .done(),
        );
    } else {
        let (start_utc, start_tz) = match &event.start {
            EventTimePoint::DateTime {
                date_time,
                time_zone,
            } => (*date_time, time_zone.clone()),
            _ => {
                return Err(DayaliError::schema_invalid(
                    "/start",
                    "événement horaire sans instant",
                ))
            }
        };
        let end_utc = match &event.end {
            EventTimePoint::DateTime { date_time, .. } => *date_time,
            _ => {
                return Err(DayaliError::schema_invalid(
                    "/end",
                    "événement horaire sans instant",
                ))
            }
        };
        ev.starts(start_utc);
        ev.ends(end_utc);
        ev.add_property("X-DAYALI-TZID", start_tz);
    }

    if let Some(project_id) = &event.project_id {
        ev.add_property("X-DAYALI-PROJECT", project_id);
    }

    let ev = ev.done();
    calendar.push(ev);
    Ok(calendar.to_string())
}

/// Convertit un texte iCalendar en événement local.
pub fn from_ics(text: &str, file_id: &str, fallback_tz: &str) -> Result<LocalCalendarEvent, DayaliError> {
    let calendar = Calendar::from_str(text).map_err(|error| {
        DayaliError::schema_invalid("/calendar", format!("ICS illisible : {error}"))
    })?;
    let events: Vec<&Event> = calendar.events().collect();
    if events.len() != 1 {
        return Err(DayaliError::schema_invalid(
            "/calendar",
            "un fichier d'événement local doit contenir exactement un VEVENT",
        ));
    }
    let event = events[0];

    let uid = event.property_value("UID").unwrap_or("");
    if uid != format!("{file_id}@dayali.local") {
        return Err(DayaliError::schema_invalid(
            "/calendar",
            "l'UID du fichier ne correspond pas au stem attendu",
        ));
    }

    let start_prop = event
        .properties()
        .get("DTSTART")
        .ok_or_else(|| DayaliError::schema_invalid("/calendar", "DTSTART absent"))?;
    let all_day = start_prop.value_type() == Some(ValueType::Date);

    let (start_point, end_point) = if all_day {
        let start_date = NaiveDate::parse_from_str(start_prop.value(), "%Y%m%d")
            .map_err(|_| DayaliError::schema_invalid("/calendar", "DTSTART date invalide"))?;
        let end_prop = event.properties().get("DTEND");
        let end_date = match end_prop {
            Some(prop) => NaiveDate::parse_from_str(prop.value(), "%Y%m%d")
                .map_err(|_| DayaliError::schema_invalid("/calendar", "DTEND date invalide"))?,
            None => start_date.succ_opt().unwrap_or(start_date),
        };
        (
            EventTimePoint::Date {
                date: start_date.to_string(),
            },
            EventTimePoint::Date {
                date: end_date.to_string(),
            },
        )
    } else {
        let tz_name_raw = event.property_value("X-DAYALI-TZID").map(|s| s.to_string());
        let tz_name = match tz_name_raw {
            Some(name) if is_time_zone_name(&name) => name,
            _ => {
                if is_time_zone_name(fallback_tz) {
                    fallback_tz.to_string()
                } else {
                    "UTC".to_string()
                }
            }
        };

        let start_utc = parse_dt_property(start_prop)?;
        let end_prop = event
            .properties()
            .get("DTEND")
            .ok_or_else(|| DayaliError::schema_invalid("/calendar", "DTEND absent"))?;
        let end_utc = parse_dt_property(end_prop)?;

        (
            EventTimePoint::DateTime {
                date_time: start_utc,
                time_zone: tz_name.clone(),
            },
            EventTimePoint::DateTime {
                date_time: end_utc,
                time_zone: tz_name,
            },
        )
    };

    let status = EventStatus::from_ics(event.property_value("STATUS").unwrap_or("CONFIRMED"));

    let sequence = event
        .property_value("SEQUENCE")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0);

    let dtstamp = event.get_timestamp();
    let created_dt = event.get_created().or(dtstamp);
    let last_modified_dt = event.get_last_modified().or(dtstamp);

    let neutral = "1970-01-01T00:00:00.000Z".to_string();
    let created_at = created_dt.map(to_iso).unwrap_or_else(|| neutral.clone());
    let updated_at = last_modified_dt.map(to_iso).unwrap_or(neutral);

    let project_id = event.property_value("X-DAYALI-PROJECT").map(|s| s.to_string());

    let mut model = LocalCalendarEvent::new(
        file_id,
        &format!("{file_id}@dayali.local"),
        event.property_value("SUMMARY").unwrap_or(""),
        all_day,
        start_point,
        end_point,
        status,
        sequence,
        &created_at,
        &updated_at,
        project_id,
        None,
    );
    model.description = event.get_description().map(|s| s.to_string());
    model.location = event.get_location().map(|s| s.to_string());
    model.validate()?;
    Ok(model)
}

fn parse_dt_property(prop: &Property) -> Result<DateTime<Utc>, DayaliError> {
    let dpt = DatePerhapsTime::from_property(prop)
        .ok_or_else(|| DayaliError::schema_invalid("/calendar", "date-time invalide"))?;
    match dpt {
        DatePerhapsTime::DateTime(icalendar::CalendarDateTime::Utc(dt)) => Ok(dt),
        DatePerhapsTime::DateTime(icalendar::CalendarDateTime::WithTimezone { date_time, tzid }) => {
            let tz = crate::services::day::parse_time_zone(&tzid)
                .ok_or_else(|| DayaliError::schema_invalid("/calendar", "fuseau iCal inconnu"))?;
            let local = date_time
                .and_local_timezone(tz)
                .single()
                .ok_or_else(|| DayaliError::schema_invalid("/calendar", "horaire ambigu"))?;
            Ok(local.with_timezone(&Utc))
        }
        DatePerhapsTime::DateTime(icalendar::CalendarDateTime::Floating(naive)) => {
            Ok(DateTime::from_naive_utc_and_offset(naive, Utc))
        }
        DatePerhapsTime::Date(date) => Ok(DateTime::from_naive_utc_and_offset(
            date.and_hms_opt(0, 0, 0).unwrap_or_default(),
            Utc,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::parse_iso;

    fn sample_event(all_day: bool) -> LocalCalendarEvent {
        if all_day {
            LocalCalendarEvent::new(
                "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d",
                "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d@dayali.local",
                "Journée entière",
                true,
                EventTimePoint::Date {
                    date: "2026-10-27".to_string(),
                },
                EventTimePoint::Date {
                    date: "2026-10-28".to_string(),
                },
                EventStatus::Confirmed,
                2,
                "2026-10-25T14:00:00.000Z",
                "2026-10-26T18:45:00.000Z",
                Some("projet--abc12345".to_string()),
                None,
            )
        } else {
            LocalCalendarEvent::new(
                "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d",
                "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d@dayali.local",
                "Point projet, avec; caractères\nspéciaux",
                false,
                EventTimePoint::DateTime {
                    date_time: parse_iso("2026-10-27T08:30:00.000Z").unwrap(),
                    time_zone: "Europe/Paris".to_string(),
                },
                EventTimePoint::DateTime {
                    date_time: parse_iso("2026-10-27T09:30:00.000Z").unwrap(),
                    time_zone: "Europe/Paris".to_string(),
                },
                EventStatus::Tentative,
                1,
                "2026-10-25T14:00:00.000Z",
                "2026-10-26T18:45:00.000Z",
                None,
                None,
            )
        }
    }

    #[test]
    fn round_trip_all_day() {
        let event = sample_event(true);
        let ics = to_ics(&event).unwrap();
        assert!(ics.contains("VALUE=DATE"));
        let back = from_ics(&ics, "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "Europe/Paris").unwrap();
        assert_eq!(back, event);
        assert!(back.machine_id.is_none());
    }

    #[test]
    fn round_trip_timed() {
        let event = sample_event(false);
        let ics = to_ics(&event).unwrap();
        assert!(ics.contains("X-DAYALI-TZID:Europe/Paris"));
        let back = from_ics(&ics, "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "Europe/Paris").unwrap();
        let mut expected = event.clone();
        expected.machine_id = None;
        assert_eq!(back, expected);
    }

    #[test]
    fn escaping_survives_round_trip() {
        let event = sample_event(false);
        let ics = to_ics(&event).unwrap();
        assert!(ics.contains(r"Point projet\, avec\; caractères\nspéciaux"));
        let back = from_ics(&ics, "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "Europe/Paris").unwrap();
        assert_eq!(back.title, "Point projet, avec; caractères\nspéciaux");
    }

    #[test]
    fn uid_mismatch_is_rejected() {
        let event = sample_event(false);
        let ics = to_ics(&event).unwrap();
        let error = from_ics(&ics, "00000000-0000-0000-0000-000000000000", "Europe/Paris").unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::SchemaInvalid);
    }

    #[test]
    fn corrupt_file_is_rejected() {
        let error = from_ics("not an ics file", "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "Europe/Paris").unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::SchemaInvalid);
    }

    #[test]
    fn fallback_tz_used_when_x_dayali_tzid_missing() {
        let event = sample_event(false);
        let mut ics = to_ics(&event).unwrap();
        ics = ics.replace("X-DAYALI-TZID:Europe/Paris\r\n", "");
        let back = from_ics(&ics, "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "America/New_York").unwrap();
        match back.start {
            EventTimePoint::DateTime { time_zone, .. } => assert_eq!(time_zone, "America/New_York"),
            _ => panic!("expected datetime"),
        }
    }

    #[test]
    fn invalid_x_dayali_tzid_falls_back() {
        let event = sample_event(false);
        let ics = to_ics(&event).unwrap().replace("Europe/Paris", "NotAZone");
        let back = from_ics(&ics, "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d", "Europe/Paris").unwrap();
        match back.start {
            EventTimePoint::DateTime { time_zone, .. } => assert_eq!(time_zone, "Europe/Paris"),
            _ => panic!("expected datetime"),
        }
    }
}

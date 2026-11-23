//! Lecture et expansion d'un flux iCal **externe** (lecture seule).
//!
//! Module pur : du texte `.ics` et une fenêtre en entrée, des `FeedOccurrence` en sortie. Aucun
//! accès disque, aucun réseau, aucun secret. Les pièges listés dans `docs/ICS-LIBRARY.md` sont
//! traités ici : `TZID` Windows/préfixés, `DATE` sans `VALUE=DATE`, `UNTIL` local, journées
//! entières indépendantes du fuseau de la machine, `EXDATE`/`RDATE`, `DURATION`, remplacements
//! `RECURRENCE-ID`, plafond d'occurrences par série.

use std::collections::HashSet;
use std::str::FromStr;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use rrule::RRuleSet;

use crate::models::calendar::{EventStatus, EventTimePoint, FeedOccurrence};

/// Plafond d'occurrences générées pour une série dans la fenêtre demandée.
pub const MAX_OCCURRENCES_PER_SERIES: u16 = 5_000;

/// Taille maximale acceptée pour un flux (octets), vérifiée par l'appelant réseau.
pub const MAX_FEED_BYTES: usize = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Lecture brute
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}

/// Un `VEVENT` brut : ses propriétés, dans l'ordre du fichier.
#[derive(Debug, Clone)]
pub struct RawEvent {
    props: Vec<Prop>,
}

impl RawEvent {
    fn first(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|prop| prop.name == name)
    }

    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> {
        self.props.iter().filter(move |prop| prop.name == name)
    }

    fn text(&self, name: &str) -> Option<String> {
        self.first(name)
            .map(|prop| unescape_text(&prop.value))
            .filter(|value| !value.trim().is_empty())
    }
}

fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        lines.push(line.to_string());
    }
    lines
}

fn split_outside_quotes(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for character in text.chars() {
        if character == '"' {
            in_quotes = !in_quotes;
            current.push(character);
        } else if character == separator && !in_quotes {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    parts.push(current);
    parts
}

fn parse_prop(line: &str) -> Option<Prop> {
    let mut in_quotes = false;
    let mut colon = None;
    for (index, character) in line.char_indices() {
        match character {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = split_outside_quotes(head, ';').into_iter();
    let name = parts.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|part| {
            let (key, raw) = part.split_once('=')?;
            Some((
                key.trim().to_ascii_uppercase(),
                raw.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();
    Some(Prop {
        name,
        params,
        value: value.to_string(),
    })
}

fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            out.push(character);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Lit un flux iCal : renvoie ses `VEVENT`. Erreur si le texte n'est pas un calendrier.
pub fn parse_calendar(text: &str) -> Result<Vec<RawEvent>, String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut events = Vec::new();
    let mut seen_calendar = false;
    let mut current: Option<Vec<Prop>> = None;
    let mut nested = 0usize;

    for line in unfold(text) {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VCALENDAR" {
            seen_calendar = true;
            continue;
        }
        if !seen_calendar {
            if line.trim().is_empty() {
                continue;
            }
            return Err("le contenu n'est pas un calendrier iCal".to_string());
        }
        if upper == "BEGIN:VEVENT" && current.is_none() {
            current = Some(Vec::new());
            nested = 0;
            continue;
        }
        if let Some(props) = current.as_mut() {
            if upper.starts_with("BEGIN:") {
                nested += 1;
                continue;
            }
            if upper == "END:VEVENT" && nested == 0 {
                events.push(RawEvent {
                    props: std::mem::take(props),
                });
                current = None;
                continue;
            }
            if upper.starts_with("END:") {
                nested = nested.saturating_sub(1);
                continue;
            }
            if nested == 0 {
                if let Some(prop) = parse_prop(&line) {
                    props.push(prop);
                }
            }
        }
    }
    if !seen_calendar {
        return Err("le contenu n'est pas un calendrier iCal".to_string());
    }
    Ok(events)
}

/// Nombre d'événements (hors remplacements d'occurrences) d'un flux.
pub fn count_events(events: &[RawEvent]) -> usize {
    events
        .iter()
        .filter(|event| event.first("RECURRENCE-ID").is_none())
        .count()
}

// ---------------------------------------------------------------------------
// Dates et fuseaux
// ---------------------------------------------------------------------------

/// Instant civil d'un événement : journée entière, ou instant UTC + fuseau d'origine.
#[derive(Debug, Clone)]
enum Moment {
    Day(NaiveDate),
    At {
        utc: DateTime<Utc>,
        tz: Tz,
        /// Heure murale dans `tz`.
        local: NaiveDateTime,
    },
}

impl Moment {
    fn key(&self) -> String {
        match self {
            Moment::Day(day) => format!("d:{day}"),
            Moment::At { utc, .. } => format!("t:{}", utc.timestamp()),
        }
    }

    fn point(&self) -> EventTimePoint {
        match self {
            Moment::Day(day) => EventTimePoint::Date {
                date: day.format("%Y-%m-%d").to_string(),
            },
            Moment::At { utc, tz, .. } => EventTimePoint::DateTime {
                date_time: *utc,
                time_zone: tz.name().to_string(),
            },
        }
    }

    fn is_day(&self) -> bool {
        matches!(self, Moment::Day(_))
    }
}

/// Table minimale Windows → IANA (flux Outlook/Exchange). Locale, hors réseau.
fn windows_zone(name: &str) -> Option<&'static str> {
    Some(match name {
        "UTC" | "Coordinated Universal Time" => "UTC",
        "Romance Standard Time" => "Europe/Paris",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "GTB Standard Time" => "Europe/Bucharest",
        "FLE Standard Time" => "Europe/Kiev",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "Russian Standard Time" => "Europe/Moscow",
        "Turkey Standard Time" => "Europe/Istanbul",
        "Israel Standard Time" => "Asia/Jerusalem",
        "Egypt Standard Time" => "Africa/Cairo",
        "South Africa Standard Time" => "Africa/Johannesburg",
        "W. Central Africa Standard Time" => "Africa/Lagos",
        "Morocco Standard Time" => "Africa/Casablanca",
        "Arab Standard Time" => "Asia/Riyadh",
        "Arabian Standard Time" => "Asia/Dubai",
        "India Standard Time" => "Asia/Kolkata",
        "China Standard Time" => "Asia/Shanghai",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Korea Standard Time" => "Asia/Seoul",
        "Singapore Standard Time" => "Asia/Singapore",
        "W. Australia Standard Time" => "Australia/Perth",
        "E. Australia Standard Time" => "Australia/Brisbane",
        "AUS Eastern Standard Time" => "Australia/Sydney",
        "New Zealand Standard Time" => "Pacific/Auckland",
        "Eastern Standard Time" => "America/New_York",
        "Central Standard Time" => "America/Chicago",
        "Mountain Standard Time" => "America/Denver",
        "US Mountain Standard Time" => "America/Phoenix",
        "Pacific Standard Time" => "America/Los_Angeles",
        "Alaskan Standard Time" => "America/Anchorage",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "Canada Central Standard Time" => "America/Regina",
        "Atlantic Standard Time" => "America/Halifax",
        "Newfoundland Standard Time" => "America/St_Johns",
        "Central America Standard Time" => "America/Guatemala",
        "SA Pacific Standard Time" => "America/Bogota",
        "E. South America Standard Time" => "America/Sao_Paulo",
        "Argentina Standard Time" => "America/Argentina/Buenos_Aires",
        _ => return None,
    })
}

/// Résout un `TZID` : nom IANA, IANA préfixé (`/mozilla.org/.../Europe/Paris`) ou nom Windows.
fn resolve_tzid(raw: &str) -> Option<Tz> {
    let name = raw.trim().trim_matches('"');
    if let Ok(tz) = Tz::from_str(name) {
        return Some(tz);
    }
    if let Some(iana) = windows_zone(name) {
        return Tz::from_str(iana).ok();
    }
    // `/mozilla.org/20050126_1/Europe/Paris` : on essaie les suffixes (3, 2 puis 1 segment).
    let segments: Vec<&str> = name.split('/').filter(|part| !part.is_empty()).collect();
    for take in [3usize, 2, 1] {
        if segments.len() >= take {
            let candidate = segments[segments.len() - take..].join("/");
            if let Ok(tz) = Tz::from_str(&candidate) {
                return Some(tz);
            }
        }
    }
    None
}

/// Heure murale → instant UTC. Heure ambiguë : la première ; heure inexistante : décalée d'une heure.
fn localize(tz: Tz, naive: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(date) => date.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
        chrono::LocalResult::None => tz
            .from_local_datetime(&(naive + Duration::hours(1)))
            .earliest()
            .map(|date| date.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&naive)),
    }
}

fn parse_naive(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M"))
        .ok()
}

fn is_date_value(prop: &Prop) -> bool {
    prop.param("VALUE")
        .is_some_and(|value| value.eq_ignore_ascii_case("DATE"))
        || (prop.value.len() == 8 && prop.value.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Lit une valeur de date/heure. `warnings` reçoit un `TZID` inconnu (repli sur le fuseau d'affichage).
fn parse_moment(prop: &Prop, display_tz: Tz, warnings: &mut Vec<String>) -> Option<Moment> {
    let value = prop.value.trim();
    if is_date_value(prop) {
        let digits: String = value.chars().take(8).collect();
        return NaiveDate::parse_from_str(&digits, "%Y%m%d")
            .ok()
            .map(Moment::Day);
    }
    if let Some(stripped) = value.strip_suffix(['Z', 'z']) {
        let naive = parse_naive(stripped)?;
        return Some(Moment::At {
            utc: Utc.from_utc_datetime(&naive),
            tz: chrono_tz::UTC,
            local: naive,
        });
    }
    let naive = parse_naive(value)?;
    let tz = match prop.param("TZID") {
        Some(tzid) => resolve_tzid(tzid).unwrap_or_else(|| {
            let message =
                format!("fuseau « {tzid} » inconnu : affiché dans le fuseau de l'ordinateur");
            if !warnings.contains(&message) {
                warnings.push(message);
            }
            display_tz
        }),
        None => display_tz,
    };
    Some(Moment::At {
        utc: localize(tz, naive),
        tz,
        local: naive,
    })
}

/// Durée ISO 8601 (`P1DT2H30M`, `PT15M`, `P2W`, signe optionnel).
fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (negative, rest) = match value.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut number = String::new();
    let mut in_time = false;
    for character in rest.chars() {
        match character {
            'T' => in_time = true,
            '0'..='9' => number.push(character),
            unit => {
                let amount: i64 = number.parse().ok()?;
                number.clear();
                total += match (unit, in_time) {
                    ('W', false) => Duration::weeks(amount),
                    ('D', false) => Duration::days(amount),
                    ('H', true) => Duration::hours(amount),
                    ('M', true) => Duration::minutes(amount),
                    ('S', true) => Duration::seconds(amount),
                    _ => return None,
                };
            }
        }
    }
    if !number.is_empty() {
        return None;
    }
    Some(if negative { -total } else { total })
}

#[derive(Debug, Clone, Copy)]
enum Span {
    Days(i64),
    Time(Duration),
}

fn span_of(start: &Moment, end: Option<&Moment>, duration: Option<Duration>) -> Span {
    match (start, end) {
        (Moment::Day(from), Some(Moment::Day(to))) => Span::Days((*to - *from).num_days().max(1)),
        (Moment::At { utc: from, .. }, Some(Moment::At { utc: to, .. })) => {
            Span::Time((*to - *from).max(Duration::zero()))
        }
        _ => match (start, duration) {
            (Moment::Day(_), Some(duration)) => Span::Days(duration.num_days().max(1)),
            (Moment::At { .. }, Some(duration)) => Span::Time(duration.max(Duration::zero())),
            (Moment::Day(_), None) => Span::Days(1),
            (Moment::At { .. }, None) => Span::Time(Duration::zero()),
        },
    }
}

fn end_of(start: &Moment, span: Span) -> Moment {
    match (start, span) {
        (Moment::Day(day), Span::Days(days)) => Moment::Day(*day + Duration::days(days)),
        (Moment::Day(day), Span::Time(_)) => Moment::Day(*day + Duration::days(1)),
        (Moment::At { utc, tz, .. }, Span::Time(duration)) => {
            let end = *utc + duration;
            Moment::At {
                utc: end,
                tz: *tz,
                local: end.with_timezone(tz).naive_local(),
            }
        }
        (Moment::At { utc, tz, .. }, Span::Days(days)) => {
            let end = *utc + Duration::days(days);
            Moment::At {
                utc: end,
                tz: *tz,
                local: end.with_timezone(tz).naive_local(),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// Fenêtre civile inclusive `from..=to`, exprimée dans le fuseau d'affichage.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    pub from_utc: DateTime<Utc>,
    /// Borne de fin **exclusive** (minuit local du lendemain de `to_date`).
    pub to_utc: DateTime<Utc>,
}

impl Window {
    pub fn new(from: NaiveDate, to: NaiveDate, display_tz: Tz) -> Option<Self> {
        let end = to.succ_opt()?;
        let midnight = |date: NaiveDate| {
            display_tz
                .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
                .earliest()
                .map(|date| date.with_timezone(&Utc))
        };
        Some(Self {
            from_date: from,
            to_date: to,
            from_utc: midnight(from)?,
            to_utc: midnight(end)?,
        })
    }

    fn intersects(&self, start: &Moment, end: &Moment) -> bool {
        match (start, end) {
            (Moment::Day(from), Moment::Day(to)) => *from <= self.to_date && *to > self.from_date,
            (Moment::At { utc: from, .. }, Moment::At { utc: to, .. }) => {
                *from < self.to_utc
                    && (*to > self.from_utc || (*to == *from && *from >= self.from_utc))
            }
            _ => false,
        }
    }
}

/// Réécrit `UNTIL` en UTC (sans `Z`, la valeur est locale au fuseau de la série).
fn normalize_rrule(raw: &str, start: &Moment) -> String {
    raw.split(';')
        .map(|part| {
            let Some(value) = part
                .strip_prefix("UNTIL=")
                .or_else(|| part.strip_prefix("until="))
            else {
                return part.to_string();
            };
            let value = value.trim();
            let date_part: String = value.chars().take(8).collect();
            match start {
                Moment::Day(_) => format!("UNTIL={date_part}T235959Z"),
                Moment::At { tz, .. } => {
                    if value.ends_with(['Z', 'z']) {
                        format!("UNTIL={value}")
                    } else {
                        let naive = if value.len() == 8 {
                            NaiveDate::parse_from_str(value, "%Y%m%d")
                                .ok()
                                .and_then(|date| date.and_hms_opt(23, 59, 59))
                        } else {
                            parse_naive(value)
                        };
                        match naive {
                            Some(naive) => {
                                format!("UNTIL={}", localize(*tz, naive).format("%Y%m%dT%H%M%SZ"))
                            }
                            None => part.to_string(),
                        }
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn format_utc(utc: DateTime<Utc>) -> String {
    utc.format("%Y%m%dT%H%M%SZ").to_string()
}

fn format_day(day: NaiveDate) -> String {
    format!("{}T000000Z", day.format("%Y%m%d"))
}

/// Début des occurrences d'une série dans la fenêtre (avant remplacement/annulation).
fn series_starts(
    event: &RawEvent,
    rrule: Option<&str>,
    start: &Moment,
    span: Span,
    window: &Window,
    display_tz: Tz,
    warnings: &mut Vec<String>,
) -> Option<(Vec<Moment>, HashSet<NaiveDate>)> {
    let mut lines = Vec::new();
    match start {
        Moment::Day(day) => lines.push(format!("DTSTART:{}", format_day(*day))),
        Moment::At { tz, local, .. } if *tz == chrono_tz::UTC => {
            lines.push(format!("DTSTART:{}Z", local.format("%Y%m%dT%H%M%S")));
        }
        Moment::At { tz, local, .. } => lines.push(format!(
            "DTSTART;TZID={}:{}",
            tz.name(),
            local.format("%Y%m%dT%H%M%S")
        )),
    }
    if let Some(rule) = rrule {
        lines.push(format!("RRULE:{}", normalize_rrule(rule, start)));
    }

    let mut excluded_days = HashSet::new();
    for prop in event.all("EXDATE") {
        for value in prop.value.split(',') {
            let single = Prop {
                name: prop.name.clone(),
                params: prop.params.clone(),
                value: value.trim().to_string(),
            };
            match (start, parse_moment(&single, display_tz, warnings)) {
                (Moment::Day(_), Some(Moment::Day(day))) => {
                    lines.push(format!("EXDATE:{}", format_day(day)));
                }
                (Moment::Day(_), Some(Moment::At { local, .. })) => {
                    lines.push(format!("EXDATE:{}", format_day(local.date())));
                }
                (Moment::At { .. }, Some(Moment::At { utc, .. })) => {
                    lines.push(format!("EXDATE:{}", format_utc(utc)));
                }
                (Moment::At { .. }, Some(Moment::Day(day))) => {
                    excluded_days.insert(day);
                }
                _ => {}
            }
        }
    }
    for prop in event.all("RDATE") {
        for value in prop.value.split(',') {
            if value.contains('/') {
                continue; // PERIOD : non pris en charge
            }
            let single = Prop {
                name: prop.name.clone(),
                params: prop.params.clone(),
                value: value.trim().to_string(),
            };
            match (start, parse_moment(&single, display_tz, warnings)) {
                (Moment::Day(_), Some(Moment::Day(day))) => {
                    lines.push(format!("RDATE:{}", format_day(day)));
                }
                (Moment::At { .. }, Some(Moment::At { utc, .. })) => {
                    lines.push(format!("RDATE:{}", format_utc(utc)));
                }
                _ => {}
            }
        }
    }

    let set = match RRuleSet::from_str(&lines.join("\n")) {
        Ok(set) => set,
        Err(_) => {
            warnings.push(
                "une série récurrente a été affichée sans répétition (règle non prise en charge)"
                    .to_string(),
            );
            return None;
        }
    };

    let slack = match span {
        Span::Days(days) => Duration::days(days),
        Span::Time(duration) => duration,
    };
    let after = (window.from_utc - slack - Duration::days(1)).naive_utc();
    let before = (window.to_utc + Duration::days(1)).naive_utc();
    let set = set
        .after(rrule::Tz::UTC.from_utc_datetime(&after))
        .before(rrule::Tz::UTC.from_utc_datetime(&before));
    let result = set.all(MAX_OCCURRENCES_PER_SERIES);
    if result.limited {
        warnings.push("une série trop longue a été tronquée".to_string());
    }

    let starts = result
        .dates
        .into_iter()
        .map(|date| match start {
            Moment::Day(_) => Moment::Day(date.date_naive()),
            Moment::At { tz, .. } => {
                let utc = date.with_timezone(&Utc);
                Moment::At {
                    utc,
                    tz: *tz,
                    local: utc.with_timezone(tz).naive_local(),
                }
            }
        })
        .collect();
    Some((starts, excluded_days))
}

struct Builder<'a> {
    feed_id: &'a str,
}

impl Builder<'_> {
    #[allow(clippy::too_many_arguments)]
    fn occurrence(
        &self,
        event: &RawEvent,
        uid: &str,
        start: &Moment,
        end: &Moment,
        occurrence_start: &Moment,
        recurring: bool,
        status: EventStatus,
    ) -> FeedOccurrence {
        FeedOccurrence {
            calendar_id: self.feed_id.to_string(),
            uid: uid.to_string(),
            series_uid: uid.to_string(),
            occurrence_start: occurrence_start.point(),
            is_recurring: recurring,
            read_only: true,
            title: event
                .text("SUMMARY")
                .unwrap_or_else(|| "(Sans titre)".to_string()),
            description: event.text("DESCRIPTION"),
            location: event.text("LOCATION"),
            all_day: start.is_day(),
            start: start.point(),
            end: end.point(),
            status,
            project_id: None,
            calendar_name: None,
            calendar_color: None,
        }
    }
}

fn status_of(event: &RawEvent) -> EventStatus {
    event
        .first("STATUS")
        .map(|prop| EventStatus::from_ics(&prop.value))
        .unwrap_or(EventStatus::Confirmed)
}

/// Occurrences d'un flux dans la fenêtre. Les événements annulés ne sont pas renvoyés.
pub fn expand(
    events: &[RawEvent],
    feed_id: &str,
    display_tz: Tz,
    window: &Window,
    warnings: &mut Vec<String>,
) -> Vec<FeedOccurrence> {
    let builder = Builder { feed_id };
    let uid_of = |event: &RawEvent, index: usize| {
        event
            .first("UID")
            .map(|prop| prop.value.trim().to_string())
            .filter(|uid| !uid.is_empty())
            .unwrap_or_else(|| format!("sans-uid-{index}"))
    };

    // Remplacements (`RECURRENCE-ID`) : ils prennent la place de l'occurrence générée.
    let mut replaced: HashSet<(String, String)> = HashSet::new();
    let mut out = Vec::new();
    for (index, event) in events.iter().enumerate() {
        let Some(recurrence_id) = event.first("RECURRENCE-ID") else {
            continue;
        };
        let uid = uid_of(event, index);
        let Some(original) = parse_moment(recurrence_id, display_tz, warnings) else {
            continue;
        };
        replaced.insert((uid.clone(), original.key()));
        let status = status_of(event);
        if status == EventStatus::Cancelled {
            continue;
        }
        let Some(start) = event
            .first("DTSTART")
            .and_then(|prop| parse_moment(prop, display_tz, warnings))
        else {
            continue;
        };
        let end = event
            .first("DTEND")
            .and_then(|prop| parse_moment(prop, display_tz, warnings));
        let duration = event
            .first("DURATION")
            .and_then(|prop| parse_duration(&prop.value));
        let end = end_of(&start, span_of(&start, end.as_ref(), duration));
        if window.intersects(&start, &end) {
            out.push(builder.occurrence(event, &uid, &start, &end, &original, true, status));
        }
    }

    for (index, event) in events.iter().enumerate() {
        if event.first("RECURRENCE-ID").is_some() {
            continue;
        }
        let uid = uid_of(event, index);
        let Some(start) = event
            .first("DTSTART")
            .and_then(|prop| parse_moment(prop, display_tz, warnings))
        else {
            continue;
        };
        let status = status_of(event);
        if status == EventStatus::Cancelled {
            continue;
        }
        let dtend = event
            .first("DTEND")
            .and_then(|prop| parse_moment(prop, display_tz, warnings));
        let duration = event
            .first("DURATION")
            .and_then(|prop| parse_duration(&prop.value));
        let span = span_of(&start, dtend.as_ref(), duration);

        let rrule = event
            .first("RRULE")
            .map(|prop| prop.value.trim().to_string());
        let has_rdate = event.first("RDATE").is_some();
        if rrule.is_none() && !has_rdate {
            let end = end_of(&start, span);
            if window.intersects(&start, &end) {
                out.push(builder.occurrence(event, &uid, &start, &end, &start, false, status));
            }
            continue;
        }

        match series_starts(
            event,
            rrule.as_deref(),
            &start,
            span,
            window,
            display_tz,
            warnings,
        ) {
            Some((starts, excluded_days)) => {
                for occurrence_start in starts {
                    if replaced.contains(&(uid.clone(), occurrence_start.key())) {
                        continue;
                    }
                    if let Moment::At { local, .. } = &occurrence_start {
                        if excluded_days.contains(&local.date()) {
                            continue;
                        }
                    }
                    let end = end_of(&occurrence_start, span);
                    if window.intersects(&occurrence_start, &end) {
                        out.push(builder.occurrence(
                            event,
                            &uid,
                            &occurrence_start,
                            &end,
                            &occurrence_start,
                            true,
                            status,
                        ));
                    }
                }
            }
            None => {
                let end = end_of(&start, span);
                if window.intersects(&start, &end) {
                    out.push(builder.occurrence(event, &uid, &start, &end, &start, false, status));
                }
            }
        }
    }
    out
}

/// Clé de tri chronologique (début de l'occurrence, minuit local pour une journée entière).
pub fn sort_key(point: &EventTimePoint, display_tz: Tz) -> i64 {
    match point {
        EventTimePoint::DateTime { date_time, .. } => date_time.timestamp(),
        EventTimePoint::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .and_then(|naive| display_tz.from_local_datetime(&naive).earliest())
            .map(|date| date.timestamp())
            .unwrap_or(i64::MIN),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calendar(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}END:VCALENDAR\r\n")
    }

    fn window(from: &str, to: &str, tz: Tz) -> Window {
        Window::new(
            NaiveDate::parse_from_str(from, "%Y-%m-%d").unwrap(),
            NaiveDate::parse_from_str(to, "%Y-%m-%d").unwrap(),
            tz,
        )
        .unwrap()
    }

    fn run(ics: &str, from: &str, to: &str, tz: Tz) -> (Vec<FeedOccurrence>, Vec<String>) {
        let events = parse_calendar(ics).unwrap();
        let mut warnings = Vec::new();
        let mut out = expand(&events, "feed-1", tz, &window(from, to, tz), &mut warnings);
        out.sort_by_key(|occurrence| sort_key(&occurrence.start, tz));
        (out, warnings)
    }

    fn utc(point: &EventTimePoint) -> DateTime<Utc> {
        match point {
            EventTimePoint::DateTime { date_time, .. } => *date_time,
            EventTimePoint::Date { .. } => panic!("date-heure attendue"),
        }
    }

    fn day(point: &EventTimePoint) -> String {
        match point {
            EventTimePoint::Date { date } => date.clone(),
            EventTimePoint::DateTime { .. } => panic!("journée entière attendue"),
        }
    }

    fn at(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap()
    }

    #[test]
    fn rejects_something_that_is_not_a_calendar() {
        assert!(parse_calendar("<html>Not found</html>").is_err());
        assert!(parse_calendar("").is_err());
    }

    #[test]
    fn simple_event_with_folded_lines_and_escapes() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:a@x\r\nDTSTART:20261027T090000Z\r\nDTEND:20261027T100000Z\r\nSUMMARY:Réunion\\, équipe\r\n \\nsuite\r\nEND:VEVENT\r\n",
        );
        let (out, warnings) = run(&ics, "2026-10-27", "2026-10-27", chrono_tz::Europe::Paris);
        assert!(warnings.is_empty());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "Réunion, équipe\nsuite");
        assert_eq!(utc(&out[0].start), at(2026, 10, 27, 9));
        assert_eq!(utc(&out[0].end), at(2026, 10, 27, 10));
        assert!(!out[0].all_day && !out[0].is_recurring && out[0].read_only);
    }

    #[test]
    fn all_day_series_does_not_depend_on_the_machine_zone() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:d@x\r\nDTSTART;VALUE=DATE:20261027\r\nDTEND;VALUE=DATE:20261028\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Congé\r\nEND:VEVENT\r\n",
        );
        for tz in [
            chrono_tz::UTC,
            chrono_tz::Pacific::Auckland,
            chrono_tz::America::Los_Angeles,
        ] {
            let (out, _) = run(&ics, "2026-10-20", "2026-11-05", tz);
            let days: Vec<_> = out.iter().map(|o| day(&o.start)).collect();
            assert_eq!(days, vec!["2026-10-27", "2026-10-28"], "fuseau {tz}");
            assert_eq!(day(&out[0].end), "2026-10-28");
            assert!(out[0].all_day);
        }
    }

    #[test]
    fn date_without_value_param_is_accepted() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:e@x\r\nDTSTART:20261027\r\nSUMMARY:Fête\r\nEND:VEVENT\r\n",
        );
        let (out, _) = run(&ics, "2026-10-27", "2026-10-27", chrono_tz::Europe::Paris);
        assert_eq!(out.len(), 1);
        assert_eq!(day(&out[0].end), "2026-10-28");
    }

    #[test]
    fn weekly_series_keeps_wall_clock_across_dst() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:w@x\r\nDTSTART;TZID=Europe/Paris:20261020T090000\r\nDTEND;TZID=Europe/Paris:20261020T100000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Hebdo\r\nEND:VEVENT\r\n",
        );
        let (out, warnings) = run(&ics, "2026-10-01", "2026-11-30", chrono_tz::Europe::Paris);
        assert!(warnings.is_empty());
        let starts: Vec<_> = out.iter().map(|o| utc(&o.start)).collect();
        assert_eq!(
            starts,
            vec![at(2026, 10, 20, 7), at(2026, 10, 27, 8), at(2026, 11, 3, 8)]
        );
    }

    #[test]
    fn windows_tzid_is_resolved_and_unknown_tzid_warns() {
        let windows = calendar(
            "BEGIN:VEVENT\r\nUID:o@x\r\nDTSTART;TZID=Romance Standard Time:20261020T090000\r\nSUMMARY:Outlook\r\nEND:VEVENT\r\n",
        );
        let (out, warnings) = run(&windows, "2026-10-20", "2026-10-20", chrono_tz::UTC);
        assert!(warnings.is_empty());
        assert_eq!(utc(&out[0].start), at(2026, 10, 20, 7));

        let unknown = calendar(
            "BEGIN:VEVENT\r\nUID:u@x\r\nDTSTART;TZID=Mars/Olympus:20261020T090000\r\nSUMMARY:?\r\nEND:VEVENT\r\n",
        );
        let (out, warnings) = run(&unknown, "2026-10-20", "2026-10-20", chrono_tz::Europe::Paris);
        assert_eq!(out.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Mars/Olympus"));
    }

    #[test]
    fn byday_series_and_local_until_are_rewritten_in_utc() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:b@x\r\nDTSTART;TZID=Europe/Paris:20260105T090000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260120T090000\r\nSUMMARY:Cours\r\nEND:VEVENT\r\n",
        );
        let (out, warnings) = run(&ics, "2026-01-01", "2026-02-28", chrono_tz::Europe::Paris);
        assert!(warnings.is_empty());
        let days: Vec<_> = out
            .iter()
            .map(|o| {
                utc(&o.start)
                    .with_timezone(&chrono_tz::Europe::Paris)
                    .format("%m-%d")
                    .to_string()
            })
            .collect();
        assert_eq!(days, vec!["01-05", "01-07", "01-12", "01-14", "01-19"]);
    }

    #[test]
    fn exdate_and_override_and_cancelled_override() {
        let base = "BEGIN:VEVENT\r\nUID:s@x\r\nDTSTART;TZID=Europe/Paris:20261102T100000\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEXDATE;TZID=Europe/Paris:20261104T100000\r\nSUMMARY:Série\r\nEND:VEVENT\r\n";
        let moved = "BEGIN:VEVENT\r\nUID:s@x\r\nRECURRENCE-ID;TZID=Europe/Paris:20261105T100000\r\nDTSTART;TZID=Europe/Paris:20261105T140000\r\nSUMMARY:déplacé\r\nEND:VEVENT\r\n";
        let paris = chrono_tz::Europe::Paris;
        let (out, _) = run(&calendar(&format!("{base}{moved}")), "2026-11-01", "2026-11-30", paris);
        let seen: Vec<_> = out
            .iter()
            .map(|o| {
                (
                    utc(&o.start).with_timezone(&paris).format("%d %H:%M").to_string(),
                    o.title.clone(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                ("02 10:00".to_string(), "Série".to_string()),
                ("03 10:00".to_string(), "Série".to_string()),
                ("05 14:00".to_string(), "déplacé".to_string()),
                ("06 10:00".to_string(), "Série".to_string()),
            ]
        );

        let cancelled = "BEGIN:VEVENT\r\nUID:s@x\r\nRECURRENCE-ID;TZID=Europe/Paris:20261105T100000\r\nDTSTART;TZID=Europe/Paris:20261105T100000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n";
        let (out, _) = run(&calendar(&format!("{base}{cancelled}")), "2026-11-01", "2026-11-30", paris);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn duration_instead_of_dtend() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:r@x\r\nDTSTART:20261027T090000Z\r\nDURATION:PT1H30M\r\nSUMMARY:Durée\r\nEND:VEVENT\r\n",
        );
        let (out, _) = run(&ics, "2026-10-27", "2026-10-27", chrono_tz::UTC);
        assert_eq!(
            utc(&out[0].end),
            Utc.with_ymd_and_hms(2026, 10, 27, 10, 30, 0).unwrap()
        );
        assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(parse_duration("-PT15M"), Some(-Duration::minutes(15)));
        assert_eq!(parse_duration("P2W"), Some(Duration::weeks(2)));
        assert_eq!(parse_duration("garbage"), None);
    }

    #[test]
    fn cancelled_event_is_not_listed_and_window_is_respected() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:c@x\r\nDTSTART:20261027T090000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:f@x\r\nDTSTART:20261101T090000Z\r\nSUMMARY:Plus tard\r\nEND:VEVENT\r\n",
        );
        let (out, _) = run(&ics, "2026-10-27", "2026-10-30", chrono_tz::UTC);
        assert!(out.is_empty());
    }

    #[test]
    fn endless_secondly_series_is_bounded() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:z@x\r\nDTSTART:20261001T000000Z\r\nRRULE:FREQ=SECONDLY\r\nSUMMARY:Boucle\r\nEND:VEVENT\r\n",
        );
        let started = std::time::Instant::now();
        let (out, warnings) = run(&ics, "2026-10-01", "2026-10-31", chrono_tz::UTC);
        assert!(started.elapsed().as_millis() < 3_000);
        assert!(out.len() <= MAX_OCCURRENCES_PER_SERIES as usize);
        assert!(warnings.iter().any(|w| w.contains("tronquée")));
    }

    #[test]
    fn impossible_rule_returns_nothing_without_panicking() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:y@x\r\nDTSTART;VALUE=DATE:20260101\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30\r\nSUMMARY:Jamais\r\nEND:VEVENT\r\n",
        );
        let (out, _) = run(&ics, "2026-01-01", "2027-12-31", chrono_tz::UTC);
        assert!(out.len() <= 1);
    }

    /// Test manuel : `DAYALI_SMOKE_ICS=/chemin/flux.ics cargo test smoke -- --nocapture`.
    #[test]
    fn smoke_real_feed_from_env() {
        let Ok(path) = std::env::var("DAYALI_SMOKE_ICS") else {
            return;
        };
        let text = std::fs::read_to_string(path).unwrap();
        let events = parse_calendar(&text).unwrap();
        let tz = chrono_tz::Europe::Paris;
        let mut warnings = Vec::new();
        let mut out = expand(&events, "smoke", tz, &window("2026-11-01", "2027-12-31", tz), &mut warnings);
        out.sort_by_key(|occurrence| sort_key(&occurrence.start, tz));
        println!("{} événements lus, {} occurrences, {} avertissements", events.len(), out.len(), warnings.len());
        for occurrence in out.iter().take(6) {
            println!("  {:?} -> {}", occurrence.start, occurrence.title);
        }
        assert!(!events.is_empty());
    }

    #[test]
    fn valarm_inside_event_is_ignored() {
        let ics = calendar(
            "BEGIN:VEVENT\r\nUID:v@x\r\nDTSTART:20261027T090000Z\r\nSUMMARY:Avec alarme\r\nBEGIN:VALARM\r\nSUMMARY:Alarme\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n",
        );
        let (out, _) = run(&ics, "2026-10-27", "2026-10-27", chrono_tz::UTC);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "Avec alarme");
    }
}

//! Types de contrat transverses et validateurs partagés.
//!
//! Les validateurs sont volontairement explicites (pas de crate `regex`) : les
//! motifs sont simple et testables, et identiques en esprit à `docs/schemas/common.schema.json`.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::error::DayaliError;

/// Version du format persisté (PLAN §2.4). Toute autre valeur est refusée.
pub const SCHEMA_VERSION: u32 = 1;

/// Fichier du vault avec son empreinte de contenu (PLAN §5.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub rel_path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: String,
}

/// Précondition d'écriture (PLAN §5.1, §5.9). Aucune écriture n'est faite si
/// elle n'est pas satisfaite ; l'état courant est alors renvoyé à l'UI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Precondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub must_not_exist: Option<bool>,
}

impl Precondition {
    pub fn must_not_exist() -> Self {
        Self {
            hash: None,
            mtime: None,
            must_not_exist: Some(true),
        }
    }

    pub fn hash(hash: impl Into<String>) -> Self {
        Self {
            hash: Some(hash.into()),
            mtime: None,
            must_not_exist: None,
        }
    }
}

/// Vue publique d'un vault ouvert (PLAN §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub machine_id: String,
    pub config_revision: String,
}

/// Dossiers applicatifs résolus via les API Tauri (jamais codés en dur, PLAN §4.10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config_dir: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub log_dir: String,
}

/// Horodatage UTC RFC 3339 avec `Z`, millisecondes (PLAN §2.3).
pub fn to_iso(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Horodatage courant, au format de contrat.
pub fn iso_now() -> String {
    to_iso(Utc::now())
}

/// Parse un horodatage de contrat : suffixe `Z` obligatoire, pas de décalage numérique.
pub fn parse_iso(value: &str) -> Result<DateTime<Utc>, DayaliError> {
    if !value.ends_with('Z') {
        return Err(DayaliError::schema_invalid(
            "/",
            format!("horodatage sans suffixe Z : {value}"),
        ));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|error| {
            DayaliError::schema_invalid("/", format!("horodatage invalide : {value} ({error})"))
        })
}

/// Normalisation NFC (obligatoire pour tout chemin et toute comparaison, PLAN §2.3).
pub fn nfc(value: &str) -> String {
    value.nfc().collect()
}

/// SHA-256 hexadécimal minuscule, 64 caractères.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// UUID minuscule, version 1–8, variante RFC 4122 (motif de `common.$defs.uuid`).
pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase() {
                    return false;
                }
            }
        }
    }
    matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// Date civile locale `YYYY-MM-DD`.
pub fn is_local_date(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes.iter().enumerate().all(|(index, byte)| {
        if index == 4 || index == 7 {
            true
        } else {
            byte.is_ascii_digit()
        }
    }) {
        return false;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// Semver simplifié (`\\d+.\\d+.\\d+` + suffixe optionnel).
pub fn is_semver(value: &str) -> bool {
    let (core, suffix) = match value.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (value, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    match suffix {
        None => true,
        Some(suffix) => {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        }
    }
}

/// `projectId` immuable `<slug>--<8 hex>` (PLAN §2.2, `common.$defs.projectId`).
pub fn is_project_id(value: &str) -> bool {
    if value.len() < 11 || value.len() > 58 {
        return false;
    }
    let Some(index) = value.rfind("--") else {
        return false;
    };
    let (slug, suffix_with_sep) = value.split_at(index);
    let suffix = &suffix_with_sep[2..];
    if suffix.len() != 8 || !suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return false;
    }
    if slug.is_empty() || slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
        return false;
    }
    slug.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Fuseau IANA canonique : `UTC` ou au moins une région (`Europe/Paris`).
/// `CET`, `GMT` et les décalages numériques sont refusés (PLAN §2.3).
pub fn is_time_zone_name(value: &str) -> bool {
    if value == "UTC" {
        return true;
    }
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut at_segment_start = true;
    let mut has_separator = false;
    for (index, character) in value.chars().enumerate() {
        if character == '/' {
            if at_segment_start {
                return false;
            }
            at_segment_start = true;
            has_separator = true;
            continue;
        }
        let allowed = character.is_ascii_alphanumeric() || character == '_' || character == '+' || character == '-';
        if !allowed {
            return false;
        }
        if at_segment_start {
            if index == 0 && !character.is_ascii_uppercase() {
                return false;
            }
            at_segment_start = false;
        }
    }
    has_separator && !at_segment_start
}

/// Chemin absolu local : POSIX (`/…`), lecteur Windows (`C:\…`, `C:/…`) ou UNC.
pub fn is_absolute_path(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes[0] == b'/' {
        // `//serveur/partage` est un chemin UNC, donc absolu.
        return !value.starts_with("//") || value.len() > 2;
    }
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    if value.starts_with("\\\\") {
        return value.len() > 2;
    }
    false
}

/// Vérifie qu'une valeur est un objet JSON non nul (base des `filter` de vue).
pub fn is_object(value: &serde_json::Value) -> bool {
    value.is_object()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip_keeps_millis_and_z() {
        let parsed = parse_iso("2026-10-26T21:42:00.000Z").unwrap();
        assert_eq!(to_iso(parsed), "2026-10-26T21:42:00.000Z");
        assert!(parse_iso("2026-10-26T21:42:00+02:00").is_err());
        assert!(parse_iso("2026-10-26T21:42:00.000").is_err());
    }

    #[test]
    fn uuid_requires_lowercase_version_and_variant() {
        assert!(is_uuid("0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_uuid("0199A1B2-3C4D-7E5F-8A9B-0C1D2E3F4A5B"));
        assert!(!is_uuid("0199a1b2-3c4d-0e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_uuid("0199a1b2-3c4d-7e5f-ca9b-0c1d2e3f4a5b"));
        assert!(!is_uuid("machine-1"));
    }

    #[test]
    fn project_id_pattern() {
        assert!(is_project_id("refonte-site--3fa9c2d1"));
        assert!(!is_project_id("refonte--site--3fa9c2d1"));
        assert!(!is_project_id("refonte---3fa9c2d1"));
        assert!(!is_project_id("refonte-site--3FA9C2D1"));
        assert!(!is_project_id("refonte-site--3fa9c2d"));
    }

    #[test]
    fn time_zone_pattern_rejects_offsets() {
        assert!(is_time_zone_name("Europe/Paris"));
        assert!(is_time_zone_name("UTC"));
        assert!(is_time_zone_name("America/Argentina/Buenos_Aires"));
        assert!(!is_time_zone_name("CET"));
        assert!(!is_time_zone_name("GMT+1"));
        assert!(!is_time_zone_name("Europe/"));
        assert!(!is_time_zone_name("europe/Paris"));
    }

    #[test]
    fn absolute_path_detection() {
        assert!(is_absolute_path("/Users/tiago/Dayali"));
        assert!(is_absolute_path("C:\\Users\\tiago\\Dayali"));
        assert!(is_absolute_path("C:/Users/tiago/Dayali"));
        assert!(is_absolute_path("\\\\serveur\\partage\\Dayali"));
        assert!(!is_absolute_path("Dayali"));
        assert!(!is_absolute_path("~/Dayali"));
        assert!(!is_absolute_path("https://example.org/vault"));
    }

    #[test]
    fn local_date_and_semver() {
        assert!(is_local_date("2026-10-26"));
        assert!(!is_local_date("2026-02-30"));
        assert!(!is_local_date("26/10/2026"));
        assert!(is_semver("0.1.0"));
        assert!(is_semver("1.2.3-beta.1"));
        assert!(!is_semver("1.2"));
    }

    #[test]
    fn nfc_normalizes_decomposed_input() {
        assert_eq!(nfc("e\u{301}te\u{301}"), "été");
    }
}

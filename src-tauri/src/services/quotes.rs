//! Compaction des tombstones de `quotes/custom.json` (PLAN §4.9, N6).
//!
//! Un tombstone est une citation dont `deletedAt` est non nul. La compaction
//! n'enlève **jamais** une citation active : elle ne supprime que des
//! tombstones, anciens au-delà d'un délai (`max_age_days`) ou au-delà d'un
//! plafond (`max_tombstones`). Le fichier n'est réécrit que si au moins un
//! tombstone est effectivement retiré ; une course concurrente se résout par
//! une précondition de hash, sans écrasement silencieux.

use std::collections::HashSet;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::Precondition;
use crate::services;
use crate::vault::{atomic, fs as vault_fs, hash, paths};

/// Chemin relatif canonique du fichier de citations personnelles.
pub const QUOTES_REL_PATH: &str = "quotes/custom.json";
/// Délai par défaut au-delà duquel un tombstone est compactable (30 jours).
pub const DEFAULT_TOMBSTONE_MAX_AGE_DAYS: i64 = 30;
/// Plafond par défaut du nombre de tombstones conservés.
pub const DEFAULT_TOMBSTONE_CAP: usize = 1000;

fn deleted_at(quote: &Value) -> Option<DateTime<Utc>> {
    quote
        .get("deletedAt")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|instant| instant.with_timezone(&Utc))
}

fn is_tombstone(quote: &Value) -> bool {
    matches!(quote.get("deletedAt"), Some(Value::String(_)))
}

/// Compacte une liste de citations en place.
///
/// Retourne le nombre de tombstones effectivement retirés. Les citations actives
/// (`deletedAt == null` ou absent) ne sont jamais touchées ; un tombstone dont
/// la date est illisible est conservé (aucune perte silencieuse).
pub fn compact_tombstones(
    quotes: &mut Vec<Value>,
    now: DateTime<Utc>,
    max_age_days: i64,
    max_tombstones: usize,
) -> usize {
    // 1. Retrait par âge.
    let mut kept: Vec<Value> = Vec::with_capacity(quotes.len());
    let mut removed = 0usize;
    for quote in quotes.drain(..) {
        if is_tombstone(&quote) {
            if let Some(timestamp) = deleted_at(&quote) {
                if (now - timestamp).num_days() > max_age_days {
                    removed += 1;
                    continue;
                }
            }
        }
        kept.push(quote);
    }

    // 2. Plafond : on ne retire que les plus anciens tombstones lisibles.
    let tombstone_positions: Vec<usize> = kept
        .iter()
        .enumerate()
        .filter(|(_, quote)| is_tombstone(quote))
        .map(|(index, _)| index)
        .collect();

    if tombstone_positions.len() > max_tombstones {
        let mut sortable: Vec<(usize, Option<DateTime<Utc>>)> = tombstone_positions
            .iter()
            .map(|&index| (index, deleted_at(&kept[index])))
            .collect();
        sortable.sort_by(|left, right| match (&left.1, &right.1) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });

        let need_remove = tombstone_positions.len().saturating_sub(max_tombstones);
        let mut to_remove: HashSet<usize> = HashSet::new();
        let mut removed_by_cap = 0usize;
        for (index, timestamp) in &sortable {
            if removed_by_cap >= need_remove {
                break;
            }
            if timestamp.is_some() {
                to_remove.insert(*index);
                removed_by_cap += 1;
            }
        }

        let mut final_kept: Vec<Value> = Vec::with_capacity(kept.len());
        for (index, quote) in kept.into_iter().enumerate() {
            if to_remove.contains(&index) {
                removed += 1;
            } else {
                final_kept.push(quote);
            }
        }
        *quotes = final_kept;
    } else {
        *quotes = kept;
    }

    removed
}

/// Compacte `quotes/custom.json` si présent.
///
/// Retourne le nombre de tombstones retirés (0 si le fichier est absent ou si
/// aucune compaction n'a eu lieu). Une course concurrente se résout par une
/// précondition de hash : en cas de divergence, la compaction est abandonnée
/// sans écrasement (0 retiré).
pub fn compact_quotes_file(
    root: &Path,
    now: DateTime<Utc>,
    max_age_days: i64,
    max_tombstones: usize,
) -> Result<usize, DayaliError> {
    let resolved = match paths::resolve_read(root, QUOTES_REL_PATH) {
        Ok(resolved) => resolved,
        Err(error) if error.code == ErrorCode::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    let bytes = vault_fs::read_bytes_limited(&resolved.absolute, 8 * 1024 * 1024)?;
    let text = vault_fs::decode_utf8(&bytes, QUOTES_REL_PATH)?;
    let mut value: Value = services::parse_json(&text, QUOTES_REL_PATH)?;
    let current_hash = hash::sha256_bytes(&bytes);

    let removed = if let Some(Value::Array(items)) = value.get_mut("quotes") {
        let mut owned = std::mem::take(items);
        let removed = compact_tombstones(&mut owned, now, max_age_days, max_tombstones);
        *items = owned;
        removed
    } else {
        return Ok(0);
    };

    if removed == 0 {
        return Ok(0);
    }

    let bytes_out = serde_json::to_vec_pretty(&value)
        .map_err(|error| DayaliError::internal(error.to_string()))?;
    match atomic::write_vault_bytes(
        root,
        QUOTES_REL_PATH,
        &bytes_out,
        Some(&Precondition::hash(current_hash)),
        true,
    ) {
        Ok(_) => Ok(removed),
        Err(error) if error.code == ErrorCode::PreconditionFailed => Ok(0),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::parse_iso;

    fn now() -> DateTime<Utc> {
        parse_iso("2026-10-29T12:00:00.000Z").unwrap()
    }

    fn quote(id: &str, deleted_at: Option<&str>) -> Value {
        serde_json::json!({
            "id": id,
            "text": "citation",
            "author": null,
            "source": null,
            "pinned": false,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "machineId": "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
            "deletedAt": deleted_at
        })
    }

    #[test]
    fn compact_removes_old_tombstones_only() {
        let old = "2026-09-01T00:00:00.000Z"; // ~58 jours
        let recent = "2026-10-20T00:00:00.000Z"; // ~9 jours
        let mut quotes = vec![
            quote("a", Some(old)),
            quote("b", Some(recent)),
            quote("c", None),
        ];

        let removed = compact_tombstones(&mut quotes, now(), 30, 1000);
        assert_eq!(removed, 1);
        assert_eq!(quotes.len(), 2);
        assert!(quotes.iter().any(|q| q["id"] == "b"));
        assert!(quotes.iter().any(|q| q["id"] == "c"));
        assert!(!quotes.iter().any(|q| q["id"] == "a"));
    }

    #[test]
    fn compact_respects_cap_on_tombstones() {
        let mut quotes = Vec::new();
        for index in 0..5 {
            let day = format!("2026-10-{:02}T00:00:00.000Z", 10 + index);
            quotes.push(quote(&format!("t{index}"), Some(&day)));
        }
        quotes.push(quote("active", None));

        let removed = compact_tombstones(&mut quotes, now(), 365, 2);
        assert_eq!(removed, 3);
        // Les 2 tombstones les plus récents restent.
        let tombstones: Vec<&Value> = quotes.iter().filter(|q| is_tombstone(q)).collect();
        assert_eq!(tombstones.len(), 2);
        assert!(quotes.iter().any(|q| q["id"] == "active"));
    }

    #[test]
    fn compact_keeps_unparseable_tombstones() {
        let mut quotes = vec![quote("bad", Some("pas-une-date")), quote("old", Some("2026-01-01T00:00:00.000Z"))];
        let removed = compact_tombstones(&mut quotes, now(), 30, 1000);
        // L'ancien lisible est retiré, l'illisible est conservé.
        assert_eq!(removed, 1);
        assert!(quotes.iter().any(|q| q["id"] == "bad"));
        assert!(!quotes.iter().any(|q| q["id"] == "old"));
    }

    #[test]
    fn compact_file_is_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".dayali")).unwrap();
        let removed = compact_quotes_file(&root, now(), 30, 1000).unwrap();
        assert_eq!(removed, 0);
        assert!(!root.join(QUOTES_REL_PATH).exists());
    }

    #[test]
    fn compact_file_rewrites_only_when_needed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("quotes")).unwrap();
        let value = serde_json::json!({
            "schemaVersion": 1,
            "quotes": [
                quote("old", Some("2026-01-01T00:00:00.000Z")),
                quote("active", None)
            ]
        });
        std::fs::write(
            root.join(QUOTES_REL_PATH),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();

        let removed = compact_quotes_file(&root, now(), 30, 1000).unwrap();
        assert_eq!(removed, 1);

        let after: Value =
            serde_json::from_slice(&std::fs::read(root.join(QUOTES_REL_PATH)).unwrap()).unwrap();
        let quotes = after["quotes"].as_array().unwrap();
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0]["id"], "active");
    }
}

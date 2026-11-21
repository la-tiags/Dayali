//! Services applicatifs : chaque service est une fonction pure de son entrée
//! (chemins + horloge injectée), testable sans Tauri.

pub mod calendar;
pub mod config;
pub mod day;
pub mod home_photos;
pub mod quotes;
pub mod ics;
pub mod machine;
pub mod migrations;
pub mod paths;
pub mod reminders;
pub mod vault;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::FileRef;

/// Extrait un chemin JSON approximatif du message serde.
///
/// serde ne fournit pas de chemin structuré : on reconnaît les deux messages
/// stables (`unknown field`, `missing field`) et on retombe sur `/` sinon. Le
/// chemin exact des invariants est fourni par les `validate()` des modèles.
pub fn serde_json_path(error: &serde_json::Error) -> String {
    let message = error.to_string();
    for prefix in ["unknown field `", "missing field `"] {
        if let Some(rest) = message.split(prefix).nth(1) {
            if let Some(field) = rest.split('`').next() {
                return format!("/{field}");
            }
        }
    }
    "/".to_string()
}

/// Parse un JSON en erreur `E_SCHEMA_INVALID` avec chemin, sans contenu.
pub fn parse_json<T: DeserializeOwned>(text: &str, label: &str) -> Result<T, DayaliError> {
    serde_json::from_str::<T>(text).map_err(|error| {
        DayaliError::schema_invalid(
            &serde_json_path(&error),
            format!("{label} : JSON non conforme au schéma ({error})"),
        )
    })
}

/// Parse une valeur JSON en erreur `E_SCHEMA_INVALID`.
pub fn parse_json_value<T: DeserializeOwned>(
    value: Value,
    label: &str,
) -> Result<T, DayaliError> {
    serde_json::from_value::<T>(value).map_err(|error| {
        DayaliError::schema_invalid(
            &serde_json_path(&error),
            format!("{label} : valeur non conforme au schéma ({error})"),
        )
    })
}

/// Fusion profonde d'un patch dans une valeur JSON.
///
/// Les objets sont fusionnés récursivement ; **les tableaux sont remplacés en
/// bloc** (PLAN §5.4) ; `null` remplace la valeur (champs nullables). Aucune
/// donnée n'est supprimée implicitement : une clé `null` doit être explicite.
pub fn deep_merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                match target_map.get_mut(key) {
                    Some(target_value) => deep_merge(target_value, patch_value),
                    None => {
                        target_map.insert(key.clone(), patch_value.clone());
                    }
                }
            }
        }
        (target_value, patch_value) => {
            *target_value = patch_value.clone();
        }
    }
}

/// `E_PRECONDITION_FAILED` avec l'état courant complet et l'alias de révision
/// utilisé par l'UI (`currentRevision`).
pub fn precondition_failed(message: impl Into<String>, current: &FileRef) -> DayaliError {
    DayaliError::new(ErrorCode::PreconditionFailed, message)
        .with_details(serde_json::json!({
            "current": current,
            "currentRevision": current.hash,
        }))
        .retryable()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_merge_replaces_arrays_and_nulls() {
        let mut target = serde_json::json!({
            "a": { "b": 1, "c": [1, 2] },
            "d": { "e": true },
            "f": "g"
        });
        let patch = serde_json::json!({
            "a": { "c": [3], "b": 2 },
            "d": null,
            "h": { "i": 1 }
        });
        deep_merge(&mut target, &patch);
        assert_eq!(target["a"]["b"], 2);
        assert_eq!(target["a"]["c"], serde_json::json!([3]));
        assert_eq!(target["d"], Value::Null);
        assert_eq!(target["h"]["i"], 1);
        assert_eq!(target["f"], "g");
    }

    #[test]
    fn parse_error_carries_a_json_path() {
        let error = parse_json::<crate::models::config::Config>(
            "{\"schemaVersion\":1,\"unknownKey\":true}",
            "config.json",
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.unwrap()["path"], "/unknownKey");
    }
}

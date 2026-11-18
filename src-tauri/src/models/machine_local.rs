//! `machine.json` hors vault — identité autoritaire de l'installation
//! (`docs/schemas/machine-local.schema.json`, PLAN §4.10).
//!
//! Ce fichier n'est **jamais** synchronisé : il porte `lastVaultPath` et
//! `recentVaults`, interdits dans `config.json` et dans le fichier machine du vault.

use serde::{Deserialize, Serialize};

use crate::error::DayaliError;
use crate::models::common::{
    is_absolute_path, is_uuid, nfc, parse_iso, SCHEMA_VERSION,
};

pub const RECENT_VAULTS_LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineLocal {
    pub schema_version: u32,
    pub machine_id: String,
    pub created_at: String,
    pub last_vault_path: Option<String>,
    pub recent_vaults: Vec<String>,
}

impl MachineLocal {
    pub fn new(machine_id: String, created_at: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            machine_id,
            created_at,
            last_vault_path: None,
            recent_vaults: Vec::new(),
        }
    }

    /// Invariants du schéma + invariant Rust `lastVaultPath == recentVaults[0]`
    /// (constraints.md #30).
    pub fn validate(&self) -> Result<(), DayaliError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(DayaliError::schema_invalid(
                "/schemaVersion",
                format!(
                    "schemaVersion {} inconnu : seul {} est supporté (aucune réécriture)",
                    self.schema_version, SCHEMA_VERSION
                ),
            ));
        }
        if !is_uuid(&self.machine_id) {
            return Err(DayaliError::schema_invalid(
                "/machineId",
                "machineId : UUID minuscule attendu",
            ));
        }
        parse_iso(&self.created_at)?;

        if self.recent_vaults.len() > RECENT_VAULTS_LIMIT {
            return Err(DayaliError::schema_invalid(
                "/recentVaults",
                "au plus 10 vaults récents",
            ));
        }
        let mut seen: Vec<&str> = Vec::with_capacity(self.recent_vaults.len());
        for (index, path) in self.recent_vaults.iter().enumerate() {
            if !is_absolute_path(path) {
                return Err(DayaliError::schema_invalid(
                    &format!("/recentVaults/{index}"),
                    "chemin absolu local attendu (ni relatif, ni ~, ni URL)",
                ));
            }
            if seen.contains(&path.as_str()) {
                return Err(DayaliError::schema_invalid(
                    "/recentVaults",
                    "recentVaults doit être dédupliqué",
                ));
            }
            seen.push(path);
        }

        match &self.last_vault_path {
            None => {
                // Aucun vault ouvert. La liste des récents reste informative :
                // un échec d'ouverture confirmé ne doit pas effacer l'historique
                // (PLAN §4.10), donc elle n'est pas liée à `lastVaultPath`.
            }
            Some(path) => {
                if !is_absolute_path(path) {
                    return Err(DayaliError::schema_invalid(
                        "/lastVaultPath",
                        "chemin absolu local attendu",
                    ));
                }
                if self.recent_vaults.first().map(String::as_str) != Some(path.as_str()) {
                    return Err(DayaliError::schema_invalid(
                        "/recentVaults/0",
                        "lastVaultPath doit être égal à recentVaults[0]",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Mémorise une ouverture réussie : chemin en tête, dédoublonné, tronqué à 10.
    pub fn with_vault_opened(&self, absolute_path: &str) -> Self {
        let normalized = nfc(absolute_path);
        let mut recent: Vec<String> = Vec::with_capacity(RECENT_VAULTS_LIMIT);
        recent.push(normalized.clone());
        for existing in &self.recent_vaults {
            if recent.len() >= RECENT_VAULTS_LIMIT {
                break;
            }
            if existing != &normalized {
                recent.push(existing.clone());
            }
        }
        Self {
            schema_version: self.schema_version,
            machine_id: self.machine_id.clone(),
            created_at: self.created_at.clone(),
            last_vault_path: Some(normalized),
            recent_vaults: recent,
        }
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, DayaliError> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MachineLocal {
        MachineLocal {
            schema_version: 1,
            machine_id: "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b".to_string(),
            created_at: "2026-10-20T07:05:00.000Z".to_string(),
            last_vault_path: Some("/Users/tiago/Documents/Dayali".to_string()),
            recent_vaults: vec![
                "/Users/tiago/Documents/Dayali".to_string(),
                "/Volumes/Partage/Dayali".to_string(),
            ],
        }
    }

    #[test]
    fn valid_document_round_trips_camel_case() {
        let local = sample();
        local.validate().unwrap();
        let value = serde_json::to_value(&local).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["machineId"], local.machine_id);
        assert_eq!(value["lastVaultPath"], "/Users/tiago/Documents/Dayali");
        assert!(value.get("last_vault_path").is_none());
        let parsed: MachineLocal = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, local);
    }

    #[test]
    fn last_vault_path_must_be_first_recent() {
        let mut local = sample();
        local.recent_vaults = vec!["/Volumes/Partage/Dayali".to_string()];
        let error = local.validate().unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::SchemaInvalid);
        assert_eq!(error.details.unwrap()["path"], "/recentVaults/0");
    }

    #[test]
    fn recent_vaults_are_capped_deduplicated_and_most_recent_first() {
        let mut local = sample();
        for index in 0..15 {
            local = local.with_vault_opened(&format!("/tmp/vault-{index}"));
        }
        assert_eq!(local.recent_vaults.len(), RECENT_VAULTS_LIMIT);
        assert_eq!(local.recent_vaults[0], "/tmp/vault-14");
        assert_eq!(local.last_vault_path.as_deref(), Some("/tmp/vault-14"));
        let again = local.with_vault_opened("/tmp/vault-5");
        assert_eq!(again.recent_vaults[0], "/tmp/vault-5");
        assert_eq!(again.recent_vaults.iter().filter(|p| *p == "/tmp/vault-5").count(), 1);
        again.validate().unwrap();
    }

    #[test]
    fn relative_paths_and_unknown_fields_are_rejected() {
        let mut local = sample();
        local.recent_vaults = vec!["Dayali".to_string()];
        local.last_vault_path = Some("Dayali".to_string());
        assert!(local.validate().is_err());

        let json = serde_json::json!({
            "schemaVersion": 1,
            "machineId": "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
            "createdAt": "2026-10-20T07:05:00.000Z",
            "lastVaultPath": null,
            "recentVaults": [],
            "foo": true
        });
        assert!(serde_json::from_value::<MachineLocal>(json).is_err());
    }

    #[test]
    fn null_last_vault_keeps_history_valid() {
        let mut local = sample();
        local.last_vault_path = None;
        local.validate().unwrap();
        let cleared = MachineLocal::new(local.machine_id.clone(), local.created_at.clone());
        cleared.validate().unwrap();
        assert_eq!(cleared.last_vault_path, None);
        assert!(cleared.recent_vaults.is_empty());
    }
}

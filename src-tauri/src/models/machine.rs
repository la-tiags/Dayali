//! `.dayali/machines/<machineId>.json` — journal d'une machine et état local
//! (`docs/schemas/machine.schema.json`, PLAN §4.2).
//!
//! Un fichier par installation, **un seul écrivain**. Transfers et `localState`
//! y vivent ; `lastVaultPath`/`recentVaults` sont interdits ici (PLAN §4.10).

use serde::{Deserialize, Serialize};

use crate::error::DayaliError;
use crate::models::common::{
    is_absolute_path, is_local_date, is_project_id, is_semver, is_sha256_hex, is_uuid, parse_iso,
    SCHEMA_VERSION,
};
use crate::vault::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Arch {
    #[serde(rename = "arm64")]
    Arm64,
    #[serde(rename = "x86_64")]
    X8664,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferState {
    InProgress,
    Complete,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferDirection {
    Import,
    Export,
    MirrorPush,
    MirrorPull,
    VersionWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CarryOverAction {
    Tomorrow,
    Replan,
    Abandon,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderHistoryStatus {
    Pending,
    Applied,
}

impl Default for ReminderHistoryStatus {
    fn default() -> Self {
        Self::Applied
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transfer {
    pub id: String,
    pub machine_id: String,
    pub state: TransferState,
    pub direction: TransferDirection,
    pub file_id: String,
    pub project_id: Option<String>,
    pub target_path: String,
    pub source_path: Option<String>,
    pub temp_path: Option<String>,
    pub expected_size: i64,
    pub expected_hash: String,
    pub bytes_done: i64,
    pub started_at: String,
    pub last_activity_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderHistoryEntry {
    pub id: String,
    #[serde(default)]
    pub status: ReminderHistoryStatus,
    pub reminder_id: String,
    pub action: CarryOverAction,
    pub source_day: String,
    pub logical_day: String,
    pub due_date: Option<String>,
    pub new_due_date: Option<String>,
    #[serde(default)]
    pub expected_hash: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalState {
    pub last_day_start_date: Option<String>,
    pub last_day_started_at: Option<String>,
    pub late_night_shown_for: Option<String>,
    pub reminder_history: Vec<ReminderHistoryEntry>,
    pub home_image_folder: Option<String>,
    pub last_full_scan_at: Option<String>,
}

impl LocalState {
    pub fn empty() -> Self {
        Self {
            last_day_start_date: None,
            last_day_started_at: None,
            late_night_shown_for: None,
            reminder_history: Vec::new(),
            home_image_folder: None,
            last_full_scan_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineFile {
    pub schema_version: u32,
    pub machine_id: String,
    pub name: String,
    pub platform: Platform,
    pub arch: Arch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    pub created_at: String,
    pub last_seen_at: String,
    pub transfers: Vec<Transfer>,
    pub local_state: LocalState,
}

/// Profil de l'installation courante ; injecté (jamais lu de l'environnement
/// dans les services) pour que les tests soient déterministes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineProfile {
    pub name: String,
    pub platform: Platform,
    pub arch: Arch,
    pub hostname: Option<String>,
    pub os_version: Option<String>,
    pub app_version: String,
}

impl MachineFile {
    pub fn new(
        machine_id: &str,
        created_at: &str,
        last_seen_at: &str,
        vault_root: &str,
        profile: &MachineProfile,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            machine_id: machine_id.to_string(),
            name: profile.name.clone(),
            platform: profile.platform,
            arch: profile.arch,
            hostname: profile.hostname.clone(),
            os_version: profile.os_version.clone(),
            app_version: profile.app_version.clone(),
            vault_path: Some(vault_root.to_string()),
            created_at: created_at.to_string(),
            last_seen_at: last_seen_at.to_string(),
            transfers: Vec::new(),
            local_state: LocalState::empty(),
        }
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, DayaliError> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text.into_bytes())
    }

    pub fn validate(&self, expected_machine_id: &str) -> Result<(), DayaliError> {
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
        if self.machine_id != expected_machine_id {
            return Err(DayaliError::schema_invalid(
                "/machineId",
                "le machineId du fichier ne correspond pas à son nom de fichier",
            ));
        }
        let name_len = self.name.chars().count();
        if name_len == 0 || name_len > 64 {
            return Err(DayaliError::schema_invalid(
                "/name",
                "nom de machine : 1 à 64 caractères",
            ));
        }
        if let Some(hostname) = &self.hostname {
            if hostname.is_empty() || hostname.chars().count() > 255 {
                return Err(DayaliError::schema_invalid(
                    "/hostname",
                    "hostname : 1 à 255 caractères",
                ));
            }
        }
        if let Some(os_version) = &self.os_version {
            if os_version.chars().count() > 80 {
                return Err(DayaliError::schema_invalid(
                    "/osVersion",
                    "osVersion : 80 caractères maximum",
                ));
            }
        }
        if !is_semver(&self.app_version) {
            return Err(DayaliError::schema_invalid(
                "/appVersion",
                "appVersion : semver attendu (0.1.0)",
            ));
        }
        match &self.vault_path {
            Some(path) if !is_absolute_path(path) => {
                return Err(DayaliError::schema_invalid(
                    "/vaultPath",
                    "vaultPath : chemin absolu local attendu",
                ));
            }
            _ => {}
        }
        parse_iso(&self.created_at)?;
        parse_iso(&self.last_seen_at)?;

        for (index, transfer) in self.transfers.iter().enumerate() {
            self.validate_transfer(transfer, index)?;
        }
        self.validate_local_state()?;
        Ok(())
    }

    fn validate_transfer(&self, transfer: &Transfer, index: usize) -> Result<(), DayaliError> {
        let base = format!("/transfers/{index}");
        if !is_uuid(&transfer.id) {
            return Err(DayaliError::schema_invalid(
                &format!("{base}/id"),
                "transfert : UUID attendu",
            ));
        }
        if transfer.machine_id != self.machine_id {
            return Err(DayaliError::schema_invalid(
                &format!("{base}/machineId"),
                "le machineId d'un transfert doit égaler celui du fichier",
            ));
        }
        if !is_uuid(&transfer.file_id) {
            return Err(DayaliError::schema_invalid(
                &format!("{base}/fileId"),
                "fileId : UUID attendu",
            ));
        }
        if let Some(project_id) = &transfer.project_id {
            if !is_project_id(project_id) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/projectId"),
                    "projectId invalide",
                ));
            }
        }
        paths::validate_rel_path(&transfer.target_path)?;
        if let Some(source_path) = &transfer.source_path {
            if !is_absolute_path(source_path) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/sourcePath"),
                    "sourcePath : chemin absolu local attendu",
                ));
            }
        }
        if let Some(temp_path) = &transfer.temp_path {
            let temp = paths::validate_rel_path(temp_path)?;
            if !temp.starts_with(".dayali/tmp/") || !temp.ends_with(".part") {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/tempPath"),
                    "tempPath doit être sous .dayali/tmp/ et suffixé .part",
                ));
            }
        }
        if transfer.expected_size < 0 || transfer.bytes_done < 0 {
            return Err(DayaliError::schema_invalid(
                &format!("{base}/expectedSize"),
                "tailles négatives interdites",
            ));
        }
        if !is_sha256_hex(&transfer.expected_hash) {
            return Err(DayaliError::schema_invalid(
                &format!("{base}/expectedHash"),
                "expectedHash : SHA-256 hexadécimal minuscule attendu",
            ));
        }
        parse_iso(&transfer.started_at)?;
        parse_iso(&transfer.last_activity_at)?;
        if let Some(completed_at) = &transfer.completed_at {
            parse_iso(completed_at)?;
        }
        match transfer.state {
            TransferState::Complete => {
                if transfer.completed_at.is_none() {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/completedAt"),
                        "un transfert complete doit avoir completedAt",
                    ));
                }
                if transfer.error.is_some() {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/error"),
                        "un transfert complete ne porte pas d'erreur",
                    ));
                }
            }
            TransferState::InProgress => {
                if transfer.completed_at.is_some() {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/completedAt"),
                        "un transfert in-progress a completedAt null",
                    ));
                }
            }
            TransferState::Abandoned => match &transfer.error {
                Some(error) if !error.is_empty() && error.chars().count() <= 500 => {}
                _ => {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/error"),
                        "un transfert abandoned doit expliquer l'abandon",
                    ));
                }
            },
        }
        Ok(())
    }

    fn validate_local_state(&self) -> Result<(), DayaliError> {
        let state = &self.local_state;
        for (path, value) in [
            (
                "/localState/lastDayStartDate",
                state.last_day_start_date.as_deref(),
            ),
            (
                "/localState/lateNightShownFor",
                state.late_night_shown_for.as_deref(),
            ),
        ] {
            if let Some(value) = value {
                if !is_local_date(value) {
                    return Err(DayaliError::schema_invalid(
                        path,
                        "date civile locale YYYY-MM-DD attendue",
                    ));
                }
            }
        }
        for value in [
            state.last_day_started_at.as_deref(),
            state.last_full_scan_at.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            parse_iso(value)?;
        }
        if let Some(folder) = &state.home_image_folder {
            if !is_absolute_path(folder) {
                return Err(DayaliError::schema_invalid(
                    "/localState/homeImageFolder",
                    "dossier d'images : chemin absolu local attendu",
                ));
            }
        }
        if state.reminder_history.len() > 500 {
            return Err(DayaliError::schema_invalid(
                "/localState/reminderHistory",
                "au plus 500 entrées",
            ));
        }
        for (index, entry) in state.reminder_history.iter().enumerate() {
            let base = format!("/localState/reminderHistory/{index}");
            if !is_uuid(&entry.id) || !is_uuid(&entry.reminder_id) {
                return Err(DayaliError::schema_invalid(
                    &base,
                    "id et reminderId : UUID attendus",
                ));
            }
            if !is_local_date(&entry.source_day) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/sourceDay"),
                    "date civile locale attendue",
                ));
            }
            for (path, value) in [
                ("/dueDate", entry.due_date.as_deref()),
                ("/newDueDate", entry.new_due_date.as_deref()),
            ] {
                if let Some(value) = value {
                    if !is_local_date(value) {
                        return Err(DayaliError::schema_invalid(
                            &format!("{base}{path}"),
                            "date civile locale attendue",
                        ));
                    }
                }
            }
            parse_iso(&entry.created_at)?;
            if let Some(resolved_at) = &entry.resolved_at {
                parse_iso(resolved_at)?;
            }
            if matches!(entry.action, CarryOverAction::Replan) && entry.new_due_date.is_none() {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/newDueDate"),
                    "action replan : newDueDate est requis",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::to_iso;

    fn profile() -> MachineProfile {
        MachineProfile {
            name: "MacBook de test".to_string(),
            platform: Platform::Macos,
            arch: Arch::Arm64,
            hostname: Some("macbook-test.local".to_string()),
            os_version: Some("macOS 26.0".to_string()),
            app_version: "0.1.0".to_string(),
        }
    }

    fn machine_id() -> String {
        "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b".to_string()
    }

    fn sample() -> MachineFile {
        let now = to_iso(chrono::Utc::now());
        MachineFile::new(&machine_id(), &now, &now, "/tmp/dayali-test", &profile())
    }

    #[test]
    fn new_machine_file_is_valid_and_serialized_camel_case() {
        let machine = sample();
        machine.validate(&machine_id()).unwrap();
        let value = serde_json::to_value(&machine).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["arch"], "arm64");
        assert_eq!(
            value["localState"]["lastDayStartDate"],
            serde_json::Value::Null
        );
        assert_eq!(
            value["localState"]["reminderHistory"],
            serde_json::json!([])
        );
        assert!(value.get("lastVaultPath").is_none());
        assert!(value.get("recentVaults").is_none());
    }

    #[test]
    fn contract_rust_and_typescript_schema_align_on_reminder_history_and_camel_case() {
        let mut machine = sample();
        machine.local_state.reminder_history.push(ReminderHistoryEntry {
            id: "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b".to_string(),
            status: ReminderHistoryStatus::Pending,
            reminder_id: "0199a1b2-4d5e-7f60-8a1b-2c3d4e5f6a7b".to_string(),
            action: CarryOverAction::Replan,
            source_day: "2026-10-25".to_string(),
            logical_day: "2026-10-26".to_string(),
            due_date: Some("2026-10-25".to_string()),
            new_due_date: Some("2026-10-26".to_string()),
            expected_hash: Some("a".repeat(64)),
            created_at: "2026-10-25T06:48:00.000Z".to_string(),
            resolved_at: None,
        });

        machine.validate(&machine_id()).unwrap();

        let value = serde_json::to_value(&machine).unwrap();
        assert_eq!(value["machineId"], machine_id());
        assert_eq!(value["schemaVersion"], 1);

        let history = &value["localState"]["reminderHistory"];
        assert!(history.is_array());
        let entry = &history[0];

        assert_eq!(entry["id"], "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(entry["status"], "pending");
        assert_eq!(entry["reminderId"], "0199a1b2-4d5e-7f60-8a1b-2c3d4e5f6a7b");
        assert_eq!(entry["action"], "replan");
        assert_eq!(entry["sourceDay"], "2026-10-25");
        assert_eq!(entry["logicalDay"], "2026-10-26");
        assert_eq!(entry["dueDate"], "2026-10-25");
        assert_eq!(entry["newDueDate"], "2026-10-26");
        assert_eq!(entry["expectedHash"], "a".repeat(64));
        assert_eq!(entry["createdAt"], "2026-10-25T06:48:00.000Z");
        assert_eq!(entry["resolvedAt"], serde_json::Value::Null);

        let json_str = serde_json::to_string(&machine).unwrap();
        assert!(json_str.contains("\"reminderHistory\""));
        assert!(json_str.contains("\"reminderId\""));
        assert!(json_str.contains("\"sourceDay\""));
        assert!(json_str.contains("\"logicalDay\""));
        assert!(json_str.contains("\"newDueDate\""));
        assert!(json_str.contains("\"expectedHash\""));
        assert!(json_str.contains("\"machineId\""));
        assert!(!json_str.contains("\"reminder_id\""));
        assert!(!json_str.contains("\"source_day\""));
        assert!(!json_str.contains("\"logical_day\""));
        assert!(!json_str.contains("\"new_due_date\""));
        assert!(!json_str.contains("\"expected_hash\""));
        assert!(!json_str.contains("\"machine_id\""));
    }

    #[test]
    fn machine_id_must_match_file_name() {
        let machine = sample();
        let error = machine
            .validate("0199a1b2-0000-7000-8000-000000000000")
            .unwrap_err();
        assert_eq!(error.details.unwrap()["path"], "/machineId");
    }

    #[test]
    fn complete_transfer_requires_completed_at() {
        let mut machine = sample();
        machine.transfers.push(Transfer {
            id: "0199a1b2-d6e7-72a8-8da4-1f2a3b4c5d6e".to_string(),
            machine_id: machine_id(),
            state: TransferState::Complete,
            direction: TransferDirection::Import,
            file_id: "0199a1b2-4d5e-7f60-8a1b-2c3d4e5f6a7b".to_string(),
            project_id: Some("refonte-site--3fa9c2d1".to_string()),
            target_path: "projects/refonte-site--3fa9c2d1/files/specs.docx".to_string(),
            source_path: Some("/Users/tiago/Documents/Refonte/specs.docx".to_string()),
            temp_path: Some(".dayali/tmp/0199a1b2-d6e7-72a8-8da4-1f2a3b4c5d6e.part".to_string()),
            expected_size: 184_320,
            expected_hash: "a".repeat(64),
            bytes_done: 184_320,
            started_at: "2026-10-26T06:48:00.000Z".to_string(),
            last_activity_at: "2026-10-26T06:48:02.000Z".to_string(),
            completed_at: None,
            error: None,
        });
        let error = machine.validate(&machine_id()).unwrap_err();
        assert_eq!(error.details.unwrap()["path"], "/transfers/0/completedAt");
    }

    #[test]
    fn abandoned_transfer_requires_error() {
        let mut machine = sample();
        machine.transfers.push(Transfer {
            id: "0199a1b2-d6e7-72a8-8da4-1f2a3b4c5d6e".to_string(),
            machine_id: machine_id(),
            state: TransferState::Abandoned,
            direction: TransferDirection::MirrorPull,
            file_id: "0199a1b2-4d5e-7f60-8a1b-2c3d4e5f6a7b".to_string(),
            project_id: None,
            target_path: "projects/x--3fa9c2d1/files/a.bin".to_string(),
            source_path: None,
            temp_path: None,
            expected_size: 0,
            expected_hash: "b".repeat(64),
            bytes_done: 0,
            started_at: "2026-10-26T06:48:00.000Z".to_string(),
            last_activity_at: "2026-10-26T06:48:02.000Z".to_string(),
            completed_at: None,
            error: None,
        });
        let error = machine.validate(&machine_id()).unwrap_err();
        assert_eq!(error.details.unwrap()["path"], "/transfers/0/error");
    }

    #[test]
    fn temp_path_must_be_a_part_under_tmp() {
        let mut machine = sample();
        machine.transfers.push(Transfer {
            id: "0199a1b2-d6e7-72a8-8da4-1f2a3b4c5d6e".to_string(),
            machine_id: machine_id(),
            state: TransferState::InProgress,
            direction: TransferDirection::Import,
            file_id: "0199a1b2-4d5e-7f60-8a1b-2c3d4e5f6a7b".to_string(),
            project_id: None,
            target_path: "projects/x--3fa9c2d1/files/a.bin".to_string(),
            source_path: None,
            temp_path: Some("projects/x--3fa9c2d1/files/a.bin".to_string()),
            expected_size: 1,
            expected_hash: "c".repeat(64),
            bytes_done: 0,
            started_at: "2026-10-26T06:48:00.000Z".to_string(),
            last_activity_at: "2026-10-26T06:48:02.000Z".to_string(),
            completed_at: None,
            error: None,
        });
        let error = machine.validate(&machine_id()).unwrap_err();
        assert_eq!(error.details.unwrap()["path"], "/transfers/0/tempPath");
    }
}

//! Erreur applicative unique, sérialisée vers la frontière IPC.
//!
//! Contrat (PLAN §5.8) : `{ code, message, details?, retryable }` en camelCase.
//! Aucune erreur ne contient de secret ni de contenu de fichier ; `details` porte
//! uniquement des métadonnées (état courant d'un fichier, chemin JSON fautif…).

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::models::common::FileRef;

/// Codes d'erreur stables du contrat IPC (PLAN §5.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    #[serde(rename = "E_VAULT_NOT_OPEN")]
    VaultNotOpen,
    #[serde(rename = "E_NOT_FOUND")]
    NotFound,
    #[serde(rename = "E_PRECONDITION_FAILED")]
    PreconditionFailed,
    #[serde(rename = "E_HASH_MISMATCH")]
    HashMismatch,
    #[serde(rename = "E_CONFLICT")]
    Conflict,
    #[serde(rename = "E_SCHEMA_INVALID")]
    SchemaInvalid,
    #[serde(rename = "E_PERMISSION")]
    Permission,
    #[serde(rename = "E_DISK_FULL")]
    DiskFull,
    #[serde(rename = "E_STALE_TRANSFER")]
    StaleTransfer,
    #[serde(rename = "E_LOCK_TIMEOUT")]
    LockTimeout,
    #[serde(rename = "E_PATH_ESCAPE")]
    PathEscape,
    #[serde(rename = "E_UNSUPPORTED")]
    Unsupported,
    #[serde(rename = "E_TAURI")]
    Tauri,
    #[serde(rename = "E_INTERNAL")]
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::VaultNotOpen => "E_VAULT_NOT_OPEN",
            ErrorCode::NotFound => "E_NOT_FOUND",
            ErrorCode::PreconditionFailed => "E_PRECONDITION_FAILED",
            ErrorCode::HashMismatch => "E_HASH_MISMATCH",
            ErrorCode::Conflict => "E_CONFLICT",
            ErrorCode::SchemaInvalid => "E_SCHEMA_INVALID",
            ErrorCode::Permission => "E_PERMISSION",
            ErrorCode::DiskFull => "E_DISK_FULL",
            ErrorCode::StaleTransfer => "E_STALE_TRANSFER",
            ErrorCode::LockTimeout => "E_LOCK_TIMEOUT",
            ErrorCode::PathEscape => "E_PATH_ESCAPE",
            ErrorCode::Unsupported => "E_UNSUPPORTED",
            ErrorCode::Tauri => "E_TAURI",
            ErrorCode::Internal => "E_INTERNAL",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayaliError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    pub retryable: bool,
}

impl DayaliError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message).retryable()
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }

    pub fn vault_not_open() -> Self {
        Self::new(
            ErrorCode::VaultNotOpen,
            "Aucun vault n'est ouvert. Ouvre un vault avant de continuer.",
        )
    }

    /// Erreur de schéma avec chemin JSON, comme exigé par le PLAN §5.8.
    pub fn schema_invalid(path: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SchemaInvalid, message)
            .with_details(serde_json::json!({ "path": path }))
    }

    pub fn path_escape(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathEscape, message)
    }

    /// Précondition non satisfaite : `current` porte toujours l'état courant
    /// (taille + hash), pour que l'UI puisse proposer « recharger ».
    pub fn precondition_failed(message: impl Into<String>, current: Option<&FileRef>) -> Self {
        let details = match current {
            Some(file_ref) => serde_json::json!({ "current": file_ref }),
            None => serde_json::json!({ "current": serde_json::Value::Null }),
        };
        Self::new(ErrorCode::PreconditionFailed, message)
            .with_details(details)
            .retryable()
    }

    /// Traduit une erreur d'IO en code stable, sans jamais exposer de contenu.
    pub fn from_io(error: &std::io::Error, context: &str) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::Permission,
            std::io::ErrorKind::AlreadyExists => ErrorCode::PreconditionFailed,
            std::io::ErrorKind::InvalidData => ErrorCode::SchemaInvalid,
            _ => match error.raw_os_error() {
                // ENOSPC (POSIX) et ERROR_DISK_FULL (Windows).
                Some(28) | Some(112) => ErrorCode::DiskFull,
                _ => ErrorCode::Internal,
            },
        };
        let retryable = matches!(code, ErrorCode::Internal | ErrorCode::DiskFull);
        let mut mapped = Self::new(code, format!("{context} : {}", error));
        if retryable {
            mapped = mapped.retryable();
        }
        mapped
    }
}

impl fmt::Display for DayaliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} — {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for DayaliError {}

impl From<std::io::Error> for DayaliError {
    fn from(error: std::io::Error) -> Self {
        Self::from_io(&error, "accès disque")
    }
}

impl From<serde_json::Error> for DayaliError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            ErrorCode::SchemaInvalid,
            format!("JSON invalide (ligne {}, colonne {})", error.line(), error.column()),
        )
        .with_details(serde_json::json!({ "path": serde_json::Value::Null }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_the_contract_strings() {
        assert_eq!(ErrorCode::VaultNotOpen.as_str(), "E_VAULT_NOT_OPEN");
        assert_eq!(ErrorCode::PreconditionFailed.as_str(), "E_PRECONDITION_FAILED");
        assert_eq!(ErrorCode::PathEscape.as_str(), "E_PATH_ESCAPE");
        let encoded = serde_json::to_value(DayaliError::new(ErrorCode::Conflict, "conflit")).unwrap();
        assert_eq!(encoded["code"], "E_CONFLICT");
        assert_eq!(encoded["retryable"], false);
        assert!(encoded.get("details").is_none());
    }

    #[test]
    fn precondition_error_carries_current_state() {
        let current = FileRef {
            rel_path: ".dayali/config.json".to_string(),
            hash: "a".repeat(64),
            size: 12,
            mtime: "2026-10-26T21:42:00.000Z".to_string(),
        };
        let error = DayaliError::precondition_failed("révision périmée", Some(&current));
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "E_PRECONDITION_FAILED");
        assert_eq!(value["details"]["current"]["size"], 12);
        assert_eq!(value["retryable"], true);
    }
}

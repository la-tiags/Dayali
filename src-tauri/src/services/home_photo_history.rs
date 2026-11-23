//! Historique des photos d'accueil déjà affichées, **dans le vault**.
//!
//! Chaque photo affichée voit son identifiant enregistré pour ne jamais être proposée une
//! seconde fois, sur cette machine comme sur les autres (le vault est synchronisé). Seuls des
//! identifiants et des dates sont écrits : jamais l'image, jamais une URL ni une clé.
//!
//! Disposition : un fichier **par machine** (`home-photos/<machineId>.json`), comme
//! `machines/<id>.json`. Une machine n'écrit que son propre fichier, donc deux ordinateurs qui
//! se synchronisent ne produisent jamais de copie en conflit ; la lecture fait l'union de tous
//! les fichiers du dossier.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{is_uuid, Precondition};
use crate::vault::{atomic, fs as vault_fs};

const DIR: &str = "home-photos";
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// Plafond de sécurité par machine (≈ 55 ans de photos quotidiennes).
pub const MAX_SEEN_PER_MACHINE: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenPhoto {
    /// Identifiant de la photo chez le fournisseur.
    pub id: String,
    /// Journée logique (`AAAA-MM-JJ`) pendant laquelle elle a été affichée.
    pub date: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    schema_version: u32,
    machine_id: String,
    seen: Vec<SeenPhoto>,
}

fn rel_path(machine_id: &str) -> Result<String, DayaliError> {
    if !is_uuid(machine_id) {
        return Err(DayaliError::schema_invalid(
            "/machineId",
            "identifiant de machine invalide pour l'historique des photos",
        ));
    }
    Ok(format!("{DIR}/{machine_id}.json"))
}

fn valid_photo_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_date(date: &str) -> bool {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

fn parse(text: &str) -> Option<HistoryFile> {
    let file: HistoryFile = serde_json::from_str(text).ok()?;
    (file.schema_version == 1).then_some(file)
}

/// Identifiants déjà affichés, toutes machines confondues, du plus ancien au plus récent.
/// Les fichiers illisibles sont ignorés (jamais réécrits ni supprimés).
pub fn seen_ids(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(DIR)) else {
        return Vec::new();
    };
    let mut all: Vec<SeenPhoto> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(machine_id) = name.strip_suffix(".json") else {
            continue;
        };
        if !is_uuid(machine_id) {
            continue;
        }
        let Ok((text, _)) = vault_fs::read_text(root, &format!("{DIR}/{name}"), MAX_FILE_BYTES)
        else {
            continue;
        };
        if let Some(file) = parse(&text) {
            all.extend(
                file.seen
                    .into_iter()
                    .filter(|photo| valid_photo_id(&photo.id)),
            );
        }
    }
    all.sort_by(|left, right| left.date.cmp(&right.date).then(left.id.cmp(&right.id)));
    let mut seen = HashSet::new();
    all.into_iter()
        .filter(|photo| seen.insert(photo.id.clone()))
        .map(|photo| photo.id)
        .collect()
}

/// Enregistre qu'une photo a été affichée pendant `date` (idempotent).
///
/// Écrit uniquement le fichier de cette machine. Un fichier existant mais illisible n'est jamais
/// écrasé : l'erreur remonte, et l'appelant décide de continuer sans enregistrer. Deux
/// enregistrements simultanés (même machine) se rejouent : le second relit puis fusionne.
pub fn record(root: &Path, machine_id: &str, id: &str, date: &str) -> Result<(), DayaliError> {
    let mut attempt = 0;
    loop {
        match try_record(root, machine_id, id, date) {
            Err(error) if error.code == ErrorCode::PreconditionFailed && attempt < 2 => attempt += 1,
            other => return other,
        }
    }
}

fn try_record(root: &Path, machine_id: &str, id: &str, date: &str) -> Result<(), DayaliError> {
    if !valid_photo_id(id) {
        return Err(DayaliError::schema_invalid("/id", "identifiant de photo invalide"));
    }
    if !valid_date(date) {
        return Err(DayaliError::schema_invalid("/logicalDate", "date logique attendue : AAAA-MM-JJ"));
    }
    let rel = rel_path(machine_id)?;

    let (mut file, precondition) = match vault_fs::read_text(root, &rel, MAX_FILE_BYTES) {
        Ok((text, file_ref)) => {
            let file = parse(&text).ok_or_else(|| {
                DayaliError::schema_invalid(
                    "/",
                    "historique des photos illisible (conservé, non réécrit)",
                )
            })?;
            (file, Precondition::hash(file_ref.hash))
        }
        Err(error) if error.code == ErrorCode::NotFound => (
            HistoryFile {
                schema_version: 1,
                machine_id: machine_id.to_string(),
                seen: Vec::new(),
            },
            Precondition::must_not_exist(),
        ),
        Err(error) => return Err(error),
    };

    if file.seen.iter().any(|photo| photo.id == id) {
        return Ok(());
    }
    file.seen.push(SeenPhoto {
        id: id.to_string(),
        date: date.to_string(),
    });
    if file.seen.len() > MAX_SEEN_PER_MACHINE {
        let extra = file.seen.len() - MAX_SEEN_PER_MACHINE;
        file.seen.drain(0..extra);
    }

    let bytes = serde_json::to_vec_pretty(&file).map_err(|_| {
        DayaliError::new(ErrorCode::Internal, "sérialisation de l'historique des photos impossible")
    })?;
    atomic::write_vault_bytes(root, &rel, &bytes, Some(&precondition), true).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACHINE_A: &str = "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5d";
    const MACHINE_B: &str = "0199a1b2-c5d6-7197-9c93-0e1f2a3b4c5e";

    fn vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".dayali")).unwrap();
        (dir, root)
    }

    #[test]
    fn empty_vault_has_no_history() {
        let (_dir, root) = vault();
        assert!(seen_ids(&root).is_empty());
    }

    #[test]
    fn records_are_persisted_in_the_vault_and_idempotent() {
        let (_dir, root) = vault();
        record(&root, MACHINE_A, "photo-1", "2026-11-20").unwrap();
        record(&root, MACHINE_A, "photo-2", "2026-11-21").unwrap();
        record(&root, MACHINE_A, "photo-1", "2026-11-22").unwrap();

        assert_eq!(seen_ids(&root), vec!["photo-1", "photo-2"]);
        let text = std::fs::read_to_string(root.join(format!("home-photos/{MACHINE_A}.json"))).unwrap();
        assert_eq!(text.matches("photo-1").count(), 1);
        assert!(!text.contains("http"), "jamais d'URL dans le vault");
    }

    #[test]
    fn history_is_shared_between_machines_without_a_common_file() {
        let (_dir, root) = vault();
        record(&root, MACHINE_A, "a-1", "2026-11-18").unwrap();
        record(&root, MACHINE_B, "b-1", "2026-11-19").unwrap();
        record(&root, MACHINE_B, "a-1", "2026-11-20").unwrap();

        assert_eq!(seen_ids(&root), vec!["a-1", "b-1"]);
        assert!(root.join(format!("home-photos/{MACHINE_A}.json")).exists());
        assert!(root.join(format!("home-photos/{MACHINE_B}.json")).exists());
    }

    #[test]
    fn unreadable_files_are_ignored_and_never_overwritten() {
        let (_dir, root) = vault();
        std::fs::create_dir_all(root.join("home-photos")).unwrap();
        let broken = root.join(format!("home-photos/{MACHINE_A}.json"));
        std::fs::write(&broken, "{ pas du json").unwrap();
        record(&root, MACHINE_B, "ok-1", "2026-11-20").unwrap();

        assert_eq!(seen_ids(&root), vec!["ok-1"]);
        assert!(record(&root, MACHINE_A, "ok-2", "2026-11-21").is_err());
        assert_eq!(std::fs::read_to_string(&broken).unwrap(), "{ pas du json");
    }

    #[test]
    fn rejects_invalid_ids_dates_and_machines() {
        let (_dir, root) = vault();
        assert!(record(&root, MACHINE_A, "../evil", "2026-11-20").is_err());
        assert!(record(&root, MACHINE_A, "", "2026-11-20").is_err());
        assert!(record(&root, MACHINE_A, "ok", "hier").is_err());
        assert!(record(&root, "../machine", "ok", "2026-11-20").is_err());
        assert!(!root.join("home-photos").exists());
    }

    #[test]
    fn history_is_bounded_per_machine() {
        let (_dir, root) = vault();
        for index in 0..3 {
            record(&root, MACHINE_A, &format!("p{index}"), "2026-11-20").unwrap();
        }
        assert_eq!(seen_ids(&root).len(), 3);
        assert!(MAX_SEEN_PER_MACHINE >= 20_000);
    }
}

//! Écriture atomique et préconditions (PLAN §5.9).
//!
//! Algorithme, sans exception :
//!  1. précondition vérifiée **avant** toute écriture (`hash`, `mtime`,
//!     `mustNotExist`) — échec = `E_PRECONDITION_FAILED` avec l'état courant,
//!     aucune modification du fichier cible ;
//!  2. écriture du brouillon dans un dossier temporaire du **même volume**
//!     (`.dayali/tmp/write-<uuid>.tmp` dans le vault, fichier caché dans le
//!     dossier parent hors vault) ;
//!  3. `flush` + `fsync` du brouillon ;
//!  4. `rename` sur la cible (atomique ; remplacement explicite) ;
//!  5. `fsync` du dossier parent (POSIX).
//!
//! Le plafond de 8 Mio est une règle de contrat, pas une optimisation : au-delà,
//! le bon chemin est `filelink_import` (streaming `.part`), jamais un aller-retour
//! en mémoire dans la webview.
//!
//! Aucun contenu de fichier n'apparaît dans une erreur ou dans un journal.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{FileRef, Precondition};
use crate::vault::fs as vault_fs;
use crate::vault::hash;
use crate::vault::paths;

/// Plafond d'une écriture atomique en mémoire (PLAN §5.2).
pub const MAX_ATOMIC_BYTES: usize = 8 * 1024 * 1024;

/// Nombre de tentatives de `rename` sur Windows (antivirus/indexeur).
const RENAME_ATTEMPTS: u32 = 5;

/// Supprime le brouillon si une erreur survient avant le rename.
struct TempGuard(Option<PathBuf>);

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn ensure_payload_size(bytes: &[u8]) -> Result<(), DayaliError> {
    if bytes.len() > MAX_ATOMIC_BYTES {
        return Err(DayaliError::new(
            ErrorCode::Unsupported,
            format!(
                "écriture atomique limitée à {MAX_ATOMIC_BYTES} octets (reçu {} octets)",
                bytes.len()
            ),
        ));
    }
    Ok(())
}

/// État courant d'une cible, ou `None` si elle n'existe pas.
///
/// `symlink_metadata` est volontaire : un lien symbolique est un objet existant,
/// et le rename le remplace sans suivre la cible.
fn current_file_ref(target: &Path, rel_path: &str) -> Result<Option<FileRef>, DayaliError> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.is_dir() {
                return Err(DayaliError::unsupported(
                    "écriture atomique demandée sur un dossier",
                ));
            }
            if metadata.file_type().is_symlink() {
                return Err(DayaliError::path_escape(
                    "écriture atomique refusée sur un symlink",
                ));
            }
            let (hash_value, size) = hash::sha256_file(target)?;
            Ok(Some(FileRef {
                rel_path: rel_path.to_string(),
                hash: hash_value,
                size,
                mtime: vault_fs::mtime_iso(&metadata)?,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(DayaliError::from_io(&error, "cible inaccessible")),
    }
}

fn precondition_error(message: &str, current: Option<&FileRef>) -> DayaliError {
    let details = serde_json::json!({
        "current": current,
        "currentRevision": current.map(|file_ref| file_ref.hash.clone()),
    });
    DayaliError::new(ErrorCode::PreconditionFailed, message)
        .with_details(details)
        .retryable()
}

fn check_precondition(
    target: &Path,
    rel_path: &str,
    expected: Option<&Precondition>,
) -> Result<(), DayaliError> {
    let existing = current_file_ref(target, rel_path)?;

    let Some(expected) = expected else {
        // Jamais d'écrasement silencieux : une cible existante exige une
        // précondition explicite. La création d'un fichier neuf reste permise.
        return match existing {
            Some(current) => Err(precondition_error(
                "écrasement refusé sans précondition : le fichier existe déjà",
                Some(&current),
            )),
            None => Ok(()),
        };
    };

    if expected.must_not_exist == Some(true) {
        if let Some(current) = existing {
            return Err(precondition_error(
                "création refusée : le fichier existe déjà",
                Some(&current),
            ));
        }
        return Ok(());
    }

    if let Some(expected_hash) = &expected.hash {
        let current = existing.as_ref().ok_or_else(|| {
            precondition_error("fichier absent : hash attendu impossible à vérifier", None)
        })?;
        if &current.hash != expected_hash {
            return Err(precondition_error(
                "le contenu du fichier a changé depuis la lecture",
                Some(current),
            ));
        }
    }

    if let Some(expected_mtime) = &expected.mtime {
        let current = existing.as_ref().ok_or_else(|| {
            precondition_error("fichier absent : mtime attendu impossible à vérifier", None)
        })?;
        if &current.mtime != expected_mtime {
            return Err(precondition_error(
                "le fichier a été modifié depuis la lecture (mtime)",
                Some(current),
            ));
        }
    }

    Ok(())
}

/// `rename` avec quelques tentatives (Windows : partage transitoire).
fn rename_replace(from: &Path, to: &Path) -> Result<(), DayaliError> {
    let mut last_error = None;
    for attempt in 0..RENAME_ATTEMPTS {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let transient = matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                ) || matches!(error.raw_os_error(), Some(5) | Some(32));
                last_error = Some(error);
                if !transient || attempt + 1 == RENAME_ATTEMPTS {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20 * u64::from(attempt + 1)));
            }
        }
    }
    Err(DayaliError::from_io(
        &last_error.unwrap_or_else(|| std::io::Error::other("rename impossible")),
        "renommage atomique impossible",
    ))
}

/// `fsync` du dossier parent (POSIX). Les systèmes qui refusent l'opération
/// (`EINVAL`, `ENOTSUP`) sont tolérés : le fichier lui-même est déjà synchronisé.
fn sync_parent(target: &Path) -> Result<(), DayaliError> {
    #[cfg(unix)]
    {
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        match File::open(parent).and_then(|dir| dir.sync_all()) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(DayaliError::from_io(&error, "synchronisation du dossier impossible")),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = target;
        Ok(())
    }
}

/// Cœur de l'écriture atomique, indépendant du vault.
///
/// `rel_path` est la forme affichée dans le `FileRef` retourné : relative au
/// vault pour un fichier du vault, absolue pour `machine.json`.
fn write_atomic_raw(
    target: &Path,
    tmp_dir: &Path,
    rel_path: &str,
    bytes: &[u8],
    expected: Option<&Precondition>,
) -> Result<FileRef, DayaliError> {
    ensure_payload_size(bytes)?;
    check_precondition(target, rel_path, expected)?;

    fs::create_dir_all(tmp_dir)
        .map_err(|error| DayaliError::from_io(&error, "création du dossier temporaire impossible"))?;

    let tmp_path = tmp_dir.join(format!("write-{}.tmp", Uuid::now_v7()));
    let mut guard = TempGuard(Some(tmp_path.clone()));

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|error| DayaliError::from_io(&error, "création du brouillon impossible"))?;

    file.write_all(bytes)
        .map_err(|error| DayaliError::from_io(&error, "écriture du brouillon impossible"))?;
    file.flush()
        .map_err(|error| DayaliError::from_io(&error, "flush du brouillon impossible"))?;
    file.sync_all()
        .map_err(|error| DayaliError::from_io(&error, "fsync du brouillon impossible"))?;
    drop(file);

    rename_replace(&tmp_path, target)?;
    // À partir d'ici le brouillon n'existe plus sous son ancien nom.
    guard.0 = None;
    sync_parent(target)?;

    let (hash_value, size) = hash::sha256_file(target)?;
    let metadata = fs::metadata(target)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées après écriture illisibles"))?;
    Ok(FileRef {
        rel_path: rel_path.to_string(),
        hash: hash_value,
        size,
        mtime: vault_fs::mtime_iso(&metadata)?,
    })
}

/// Écrit un fichier du vault de façon atomique.
///
/// Le dossier `.dayali/tmp` est créé au besoin ; les parents du fichier ne le
/// sont que si `create_parents` est vrai. Les symlinks sont refusés en écriture.
pub fn write_vault_bytes(
    root: &Path,
    rel: &str,
    bytes: &[u8],
    expected: Option<&Precondition>,
    create_parents: bool,
) -> Result<FileRef, DayaliError> {
    ensure_payload_size(bytes)?;
    let resolved = paths::resolve_write(root, rel, create_parents)?;
    let tmp_dir = paths::canonical_root(root)?.join(".dayali").join("tmp");
    write_atomic_raw(
        &resolved.absolute,
        &tmp_dir,
        &resolved.rel_path,
        bytes,
        expected,
    )
}

/// Écrit un fichier hors vault (`machine.json`) de façon atomique.
///
/// Le brouillon reste dans le dossier parent : même volume, donc rename atomique.
/// Le fichier parent doit exister (le dossier de configuration de l'application).
pub fn write_absolute_bytes(
    target: &Path,
    bytes: &[u8],
    expected: Option<&Precondition>,
) -> Result<FileRef, DayaliError> {
    ensure_payload_size(bytes)?;
    let parent = target.parent().ok_or_else(|| {
        DayaliError::path_escape("fichier hors vault sans dossier parent")
    })?;
    if !parent.is_dir() {
        return Err(DayaliError::new(
            ErrorCode::NotFound,
            "dossier parent du fichier hors vault absent",
        ));
    }
    let rel_path = paths::normalize_absolute_display(target);
    write_atomic_raw(target, parent, &rel_path, bytes, expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join(".dayali")).unwrap();
        (dir, root)
    }

    fn read(root: &Path, rel: &str) -> Vec<u8> {
        fs::read(root.join(rel)).unwrap()
    }

    #[test]
    fn creates_new_file_with_must_not_exist_and_returns_verified_ref() {
        let (_dir, root) = vault();
        let expected = Precondition::must_not_exist();
        let file_ref = write_vault_bytes(
            &root,
            "config.json",
            b"{\"a\":1}\n",
            Some(&expected),
            false,
        )
        .unwrap();

        assert_eq!(file_ref.rel_path, "config.json");
        assert_eq!(file_ref.size, 8);
        assert_eq!(file_ref.hash, hash::sha256_bytes(b"{\"a\":1}\n"));
        assert!(file_ref.mtime.ends_with('Z'));
        assert_eq!(read(&root, "config.json"), b"{\"a\":1}\n");
    }

    #[test]
    fn refuses_overwrite_without_precondition_and_keeps_content() {
        let (_dir, root) = vault();
        fs::write(root.join("config.json"), b"original").unwrap();

        let error = write_vault_bytes(&root, "config.json", b"nouveau", None, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        let details = error.details.unwrap();
        assert_eq!(details["current"]["size"], 8);
        assert_eq!(details["current"]["hash"], hash::sha256_bytes(b"original"));
        assert_eq!(details["currentRevision"], hash::sha256_bytes(b"original"));
        assert_eq!(read(&root, "config.json"), b"original");
    }

    #[test]
    fn refuses_must_not_exist_on_existing_file() {
        let (_dir, root) = vault();
        fs::write(root.join("config.json"), b"{}").unwrap();
        let error = write_vault_bytes(
            &root,
            "config.json",
            b"{}",
            Some(&Precondition::must_not_exist()),
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(error.details.unwrap()["current"]["size"], 2);
        assert_eq!(read(&root, "config.json"), b"{}");
    }

    #[test]
    fn stale_hash_is_refused_without_writing() {
        let (_dir, root) = vault();
        fs::write(root.join("config.json"), b"version 2").unwrap();
        let stale = Precondition::hash(hash::sha256_bytes(b"version 1"));

        let error = write_vault_bytes(&root, "config.json", b"version 3", Some(&stale), false)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(
            error.details.unwrap()["current"]["hash"],
            hash::sha256_bytes(b"version 2")
        );
        assert_eq!(read(&root, "config.json"), b"version 2");
    }

    #[test]
    fn matching_hash_allows_replacement() {
        let (_dir, root) = vault();
        fs::write(root.join("config.json"), b"version 1").unwrap();
        let expected = Precondition::hash(hash::sha256_bytes(b"version 1"));
        let file_ref =
            write_vault_bytes(&root, "config.json", b"version 2", Some(&expected), false).unwrap();
        assert_eq!(file_ref.hash, hash::sha256_bytes(b"version 2"));
        assert_eq!(read(&root, "config.json"), b"version 2");
        assert_eq!(fs::read_dir(root.join(".dayali/tmp")).unwrap().count(), 0);
    }

    #[test]
    fn stale_mtime_is_refused() {
        let (_dir, root) = vault();
        fs::write(root.join("config.json"), b"{}").unwrap();
        let current = vault_fs::file_ref(&root, "config.json").unwrap();
        let mut expected = Precondition::hash(current.hash.clone());
        expected.mtime = Some("2000-01-01T00:00:00.000Z".to_string());

        let error = write_vault_bytes(&root, "config.json", b"{\"x\":1}", Some(&expected), false)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(
            error.details.unwrap()["current"]["mtime"],
            current.mtime
        );
    }

    #[test]
    fn payload_limit_is_enforced_before_touching_disk() {
        let (_dir, root) = vault();
        let bytes = vec![b'a'; MAX_ATOMIC_BYTES + 1];
        let error = write_vault_bytes(
            &root,
            "trop-gros.txt",
            &bytes,
            Some(&Precondition::must_not_exist()),
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);
        assert!(!root.join("trop-gros.txt").exists());
    }

    #[test]
    fn parents_are_only_created_when_requested() {
        let (_dir, root) = vault();
        let error = write_vault_bytes(
            &root,
            "a/b/file.json",
            b"{}",
            Some(&Precondition::must_not_exist()),
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(!root.join("a").exists());

        write_vault_bytes(
            &root,
            "a/b/file.json",
            b"{}",
            Some(&Precondition::must_not_exist()),
            true,
        )
        .unwrap();
        assert_eq!(read(&root, "a/b/file.json"), b"{}");
    }

    #[test]
    fn absolute_write_replaces_only_with_matching_hash() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("machine.json");
        let first = write_absolute_bytes(
            &target,
            b"{\"schemaVersion\":1}\n",
            Some(&Precondition::must_not_exist()),
        )
        .unwrap();
        assert_eq!(
            first.rel_path,
            paths::normalize_absolute_display(&target)
        );

        let stale = Precondition::hash(hash::sha256_bytes(b"autre"));
        let error =
            write_absolute_bytes(&target, b"{\"schemaVersion\":2}\n", Some(&stale)).unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);

        write_absolute_bytes(
            &target,
            b"{\"schemaVersion\":1,\"x\":1}\n",
            Some(&Precondition::hash(first.hash)),
        )
        .unwrap();
        assert_eq!(
            fs::read(&target).unwrap(),
            b"{\"schemaVersion\":1,\"x\":1}\n"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlink() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = vault();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("cible.json");
        fs::write(&target, b"hors vault").unwrap();
        symlink(&target, root.join("config.json")).unwrap();

        let error = write_vault_bytes(
            &root,
            "config.json",
            b"{}",
            Some(&Precondition::hash("ignoré".to_string())),
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::PathEscape);
        assert_eq!(fs::read(&target).unwrap(), b"hors vault");
    }
}

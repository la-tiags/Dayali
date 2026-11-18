//! Lecture de fichiers du vault avec empreinte vérifiée.
//!
//! « Ne jamais faire confiance à un statut sans vérifier taille et hash »
//! (SPEC §5) : `FileRef` est toujours calculé, jamais déduit d'un cache.

use std::io::Read;
use std::path::Path;

use chrono::{DateTime, Utc};

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{to_iso, FileRef};
use crate::vault::hash;
use crate::vault::paths::{self, ResolvedPath};

/// Métadonnée mtime au format de contrat (UTC, millisecondes).
pub fn mtime_iso(metadata: &std::fs::Metadata) -> Result<String, DayaliError> {
    let modified = metadata
        .modified()
        .map_err(|error| DayaliError::from_io(&error, "mtime illisible"))?;
    let instant: DateTime<Utc> = modified.into();
    Ok(to_iso(instant))
}

/// `FileRef` d'un chemin résolu (hash recalculé à chaque appel).
pub fn file_ref_resolved(resolved: &ResolvedPath) -> Result<FileRef, DayaliError> {
    let (hash_value, size) = hash::sha256_file(&resolved.absolute)?;
    let metadata = std::fs::metadata(&resolved.absolute)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées illisibles"))?;
    Ok(FileRef {
        rel_path: resolved.rel_path.clone(),
        hash: hash_value,
        size,
        mtime: mtime_iso(&metadata)?,
    })
}

/// `FileRef` d'un fichier du vault, avec validation et résolution du chemin.
pub fn file_ref(root: &Path, rel: &str) -> Result<FileRef, DayaliError> {
    let resolved = paths::resolve_read(root, rel)?;
    file_ref_resolved(&resolved)
}

/// `FileRef` d'un fichier hors vault (ex. `machine.json`).
pub fn file_ref_absolute(path: &Path) -> Result<FileRef, DayaliError> {
    let (hash_value, size) = hash::sha256_file(path)?;
    let metadata = std::fs::metadata(path)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées illisibles"))?;
    Ok(FileRef {
        rel_path: paths::normalize_absolute_display(path),
        hash: hash_value,
        size,
        mtime: mtime_iso(&metadata)?,
    })
}

/// Lit au plus `max_bytes`. Refus explicite au-delà (`E_UNSUPPORTED`).
pub fn read_bytes_limited(path: &Path, max_bytes: usize) -> Result<Vec<u8>, DayaliError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| DayaliError::from_io(&error, "fichier introuvable"))?;
    if metadata.len() > max_bytes as u64 {
        return Err(DayaliError::new(
            ErrorCode::Unsupported,
            format!(
                "fichier trop volumineux pour une lecture en mémoire ({} octets, max {max_bytes})",
                metadata.len()
            ),
        ));
    }
    let mut file = std::fs::File::open(path)
        .map_err(|error| DayaliError::from_io(&error, "ouverture impossible"))?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut buffer)
        .map_err(|error| DayaliError::from_io(&error, "lecture impossible"))?;
    if buffer.len() > max_bytes {
        return Err(DayaliError::new(
            ErrorCode::Unsupported,
            "fichier modifié pendant la lecture : taille au-delà de la limite",
        ));
    }
    Ok(buffer)
}

/// Lit un fichier du vault en UTF-8 strict (pas de BOM toléré en silence).
pub fn read_text(root: &Path, rel: &str, max_bytes: usize) -> Result<(String, FileRef), DayaliError> {
    let resolved = paths::resolve_read(root, rel)?;
    let bytes = read_bytes_limited(&resolved.absolute, max_bytes)?;
    let file_ref = file_ref_resolved(&resolved)?;
    let text = decode_utf8(&bytes, &resolved.rel_path)?;
    Ok((text, file_ref))
}

/// Décode UTF-8 en refusant le BOM (PLAN §2.4) et en nommant le fichier fautif.
pub fn decode_utf8(bytes: &[u8], label: &str) -> Result<String, DayaliError> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(DayaliError::schema_invalid(
            "/",
            format!("{label} : BOM UTF-8 interdit (fichiers sans BOM)"),
        ));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        DayaliError::schema_invalid("/", format!("{label} : encodage UTF-8 invalide"))
    })
}

/// `true` si le fichier existe (sans suivre un lien cassé).
pub fn exists(root: &Path, rel: &str) -> bool {
    match paths::validate_rel_path(rel) {
        Ok(valid) => std::fs::symlink_metadata(root.join(valid)).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_ref_recomputes_hash_and_size() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".dayali")).unwrap();
        std::fs::write(dir.path().join(".dayali/config.json"), b"{}\n").unwrap();
        let reference = file_ref(dir.path(), ".dayali/config.json").unwrap();
        assert_eq!(reference.rel_path, ".dayali/config.json");
        assert_eq!(reference.size, 3);
        assert_eq!(reference.hash, hash::sha256_bytes(b"{}\n"));
        assert!(reference.mtime.ends_with('Z'));
    }

    #[test]
    fn read_text_rejects_bom_and_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let bom = dir.path().join("bom.json");
        std::fs::write(&bom, [0xEF, 0xBB, 0xBF, b'{', b'}']).unwrap();
        let error = read_text(dir.path(), "bom.json", 1024).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);

        let invalid = dir.path().join("invalid.json");
        std::fs::write(&invalid, [0xFF, 0xFE]).unwrap();
        assert!(read_text(dir.path(), "invalid.json", 1024).is_err());
    }

    #[test]
    fn read_limit_is_enforced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("big.txt"), vec![b'a'; 128]).unwrap();
        let error = read_text(dir.path(), "big.txt", 64).unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let error = file_ref(dir.path(), "absent.json").unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(!exists(dir.path(), "absent.json"));
    }
}

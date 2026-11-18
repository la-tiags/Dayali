//! SHA-256 streaming, hex minuscule (PLAN §2.3).
//!
//! Aucun autre algorithme en V1 : le hash doit rester vérifiable par l'utilisateur
//! (`shasum -a 256`, `certutil -hashfile`) pour un format ouvert.

use std::fmt::Write as _;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::DayaliError;

/// Taille de bloc du calcul streaming : 1 Mio.
pub const HASH_CHUNK_BYTES: usize = 1024 * 1024;

/// SHA-256 d'un tampon, hex minuscule.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    to_hex(digest.as_slice())
}

/// SHA-256 d'un flux, par blocs de 1 Mio.
pub fn sha256_reader<R: Read>(mut reader: R) -> Result<String, DayaliError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| DayaliError::from_io(&error, "lecture pour hachage impossible"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(hasher.finalize().as_slice()))
}

/// SHA-256 + taille d'un fichier. Ne charge jamais le fichier entier en mémoire.
pub fn sha256_file(path: &Path) -> Result<(String, u64), DayaliError> {
    let file = File::open(path).map_err(|error| {
        DayaliError::from_io(&error, "fichier introuvable pour le hachage")
    })?;
    let reader = std::io::BufReader::with_capacity(HASH_CHUNK_BYTES, file);
    let hash = sha256_reader(reader)?;
    let size = std::fs::metadata(path)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées du fichier inaccessibles"))?
        .len();
    Ok((hash, size))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Écriture hexadécimale minuscule, sans allocation intermédiaire.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn known_vectors() {
        // Vecteurs SHA-256 publics.
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hashes_are_lowercase_hex_of_64_chars() {
        let hash = sha256_bytes(b"Dayali");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, hash.to_lowercase());
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(crate::models::common::is_sha256_hex(&hash));
    }

    #[test]
    fn streaming_matches_in_memory_at_chunk_boundaries() {
        for size in [0_usize, 1, HASH_CHUNK_BYTES - 1, HASH_CHUNK_BYTES, HASH_CHUNK_BYTES + 7] {
            let data: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            let streaming = sha256_reader(Cursor::new(data.clone())).unwrap();
            assert_eq!(streaming, sha256_bytes(&data), "taille {size}");
        }
    }

    #[test]
    fn file_hash_matches_buffer_and_reports_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        let data = vec![7_u8; 3 * HASH_CHUNK_BYTES + 11];
        std::fs::write(&path, &data).unwrap();
        let (hash, size) = sha256_file(&path).unwrap();
        assert_eq!(size, data.len() as u64);
        assert_eq!(hash, sha256_bytes(&data));
    }

    #[test]
    fn missing_file_is_e_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let error = sha256_file(&dir.path().join("absent.bin")).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::NotFound);
    }
}

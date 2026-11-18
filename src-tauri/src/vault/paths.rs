//! Validation et résolution des chemins du vault (PLAN §2.3, §5.2).
//!
//! Règles absolues :
//!  - chemin **relatif** POSIX uniquement : pas de `/` initial, pas de `\`, pas de
//!    segment `.`/`..`, pas de `/` final, pas de segment vide ;
//!  - normalisation **NFC** avant toute comparaison ;
//!  - résolution par `canonicalize` et vérification du préfixe du vault ;
//!  - en écriture, aucun composant symlink n'est traversé (`E_PATH_ESCAPE`).

use std::path::{Path, PathBuf};

use crate::error::DayaliError;
use crate::models::common::nfc;

/// Longueur maximale d'un chemin relatif (identique à `common.relativePath`).
pub const MAX_REL_PATH_LEN: usize = 1024;
/// Longueur maximale d'un nom de fichier/dossier (octets).
pub const MAX_SEGMENT_LEN: usize = 255;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    pub absolute: PathBuf,
    pub rel_path: String,
}

/// Valide un chemin relatif et le retourne normalisé NFC.
pub fn validate_rel_path(rel: &str) -> Result<String, DayaliError> {
    if rel.is_empty() {
        return Err(DayaliError::path_escape("chemin relatif vide interdit"));
    }
    if rel.len() > MAX_REL_PATH_LEN {
        return Err(DayaliError::path_escape(format!(
            "chemin relatif trop long (max {MAX_REL_PATH_LEN} octets)"
        )));
    }
    if rel.chars().any(char::is_control) {
        return Err(DayaliError::path_escape(
            "caractère de contrôle interdit dans un chemin",
        ));
    }
    let normalized = nfc(rel);
    if normalized.len() > MAX_REL_PATH_LEN {
        return Err(DayaliError::path_escape(format!(
            "chemin relatif trop long après normalisation NFC (max {MAX_REL_PATH_LEN} octets)"
        )));
    }
    if normalized.contains('\\') {
        return Err(DayaliError::path_escape(
            "séparateur \\ interdit : les chemins du vault sont POSIX",
        ));
    }
    if normalized.starts_with('/') {
        return Err(DayaliError::path_escape(
            "chemin absolu interdit : le chemin doit être relatif au vault",
        ));
    }
    if is_windows_drive_path(&normalized) {
        return Err(DayaliError::path_escape(
            "lecteur Windows interdit : le chemin doit être relatif au vault",
        ));
    }
    if normalized.ends_with('/') {
        return Err(DayaliError::path_escape("chemin terminé par / interdit"));
    }
    for segment in normalized.split('/') {
        if segment.is_empty() {
            return Err(DayaliError::path_escape(
                "segment vide interdit (// ou / initial/final)",
            ));
        }
        if segment == "." || segment == ".." {
            return Err(DayaliError::path_escape(format!(
                "segment {segment} interdit : aucun chemin ne peut sortir du vault"
            )));
        }
        if segment.len() > MAX_SEGMENT_LEN {
            return Err(DayaliError::path_escape(format!(
                "segment trop long (max {MAX_SEGMENT_LEN} octets) : {segment}"
            )));
        }
        if segment.ends_with(' ') || segment.ends_with('.') {
            return Err(DayaliError::path_escape(format!(
                "nom terminé par un espace ou un point interdit : {segment}"
            )));
        }
        if is_reserved_windows_name(segment) {
            return Err(DayaliError::path_escape(format!(
                "nom réservé par Windows interdit : {segment}"
            )));
        }
    }
    Ok(normalized)
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_reserved_windows_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if let Some(rest) = upper.strip_prefix("COM").or_else(|| upper.strip_prefix("LPT")) {
        return rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9');
    }
    false
}

/// Racine canonique du vault (résout les symlinks de la racine elle-même).
pub fn canonical_root(root: &Path) -> Result<PathBuf, DayaliError> {
    let canonical = std::fs::canonicalize(root).map_err(|error| {
        DayaliError::from_io(&error, "vault introuvable ou inaccessible")
    })?;
    if !canonical.is_dir() {
        return Err(DayaliError::path_escape(
            "le chemin du vault n'est pas un dossier",
        ));
    }
    Ok(canonical)
}

/// Vérifie qu'un chemin canonique est bien contenu dans la racine canonique.
pub fn is_inside(root_canonical: &Path, candidate: &Path) -> bool {
    candidate == root_canonical || candidate.starts_with(root_canonical)
}

/// Résout un chemin pour **lecture**. Refuse toute sortie du vault.
pub fn resolve_read(root: &Path, rel: &str) -> Result<ResolvedPath, DayaliError> {
    let rel_path = validate_rel_path(rel)?;
    let root_canonical = canonical_root(root)?;
    let joined = root_canonical.join(&rel_path);
    let metadata = std::fs::symlink_metadata(&joined)
        .map_err(|error| DayaliError::from_io(&error, "fichier introuvable"))?;
    if metadata.is_dir() {
        return Err(DayaliError::unsupported(
            "lecture de fichier demandée sur un dossier",
        ));
    }
    let absolute = std::fs::canonicalize(&joined)
        .map_err(|error| DayaliError::from_io(&error, "fichier introuvable"))?;
    if !is_inside(&root_canonical, &absolute) {
        return Err(DayaliError::path_escape(
            "le chemin résolu sort du vault (symlink ou montage)",
        ));
    }
    Ok(ResolvedPath { absolute, rel_path })
}

/// Résout un chemin pour **écriture** : crée les parents si demandé, refuse les
/// symlinks sur chaque composant (aucune écriture au travers d'un lien).
pub fn resolve_write(
    root: &Path,
    rel: &str,
    create_parents: bool,
) -> Result<ResolvedPath, DayaliError> {
    let rel_path = validate_rel_path(rel)?;
    let root_canonical = canonical_root(root)?;
    let segments: Vec<&str> = rel_path.split('/').collect();
    let mut current = root_canonical.clone();

    for (index, segment) in segments.iter().enumerate() {
        let is_last = index + 1 == segments.len();
        let candidate = current.join(segment);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(DayaliError::path_escape(format!(
                        "symlink refusé en écriture : {}",
                        candidate.display()
                    )));
                }
                if is_last {
                    if metadata.is_dir() {
                        return Err(DayaliError::unsupported(
                            "écriture de fichier demandée sur un dossier",
                        ));
                    }
                } else if !metadata.is_dir() {
                    return Err(DayaliError::schema_invalid(
                        "/",
                        "un composant du chemin parent n'est pas un dossier",
                    ));
                }
                current = candidate;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if is_last {
                    current = candidate;
                } else if create_parents {
                    match std::fs::create_dir(&candidate) {
                        Ok(()) => current = candidate,
                        Err(create_error) if create_error.kind() == std::io::ErrorKind::AlreadyExists => {
                            current = candidate;
                        }
                        Err(create_error) => {
                            return Err(DayaliError::from_io(
                                &create_error,
                                "création du dossier parent impossible",
                            ));
                        }
                    }
                } else {
                    return Err(DayaliError::new(
                        crate::error::ErrorCode::NotFound,
                        "dossier parent absent (createParents désactivé)",
                    ));
                }
            }
            Err(error) => {
                return Err(DayaliError::from_io(&error, "chemin inaccessible"));
            }
        }
    }

    // Le parent existe forcément maintenant : canonicalise-le pour la vérification finale.
    let parent = current.parent().map(Path::to_path_buf).unwrap_or_else(|| root_canonical.clone());
    let parent_canonical = std::fs::canonicalize(&parent)
        .map_err(|error| DayaliError::from_io(&error, "dossier parent inaccessible"))?;
    if !is_inside(&root_canonical, &parent_canonical) {
        return Err(DayaliError::path_escape(
            "le dossier de destination sort du vault",
        ));
    }
    let file_name = current
        .file_name()
        .ok_or_else(|| DayaliError::path_escape("chemin de destination sans nom de fichier"))?;
    let absolute = parent_canonical.join(file_name);

    Ok(ResolvedPath { absolute, rel_path })
}

/// Forme d'affichage d'un chemin absolu : NFC, sans séparateur final superflu.
pub fn normalize_absolute_display(path: &Path) -> String {
    let text = nfc(&path.to_string_lossy());
    let is_root = text == "/" || (text.len() == 3 && text.as_bytes()[1] == b':');
    if is_root {
        return text;
    }
    text.trim_end_matches(|character| character == '/' || character == '\\')
        .to_string()
}

/// Nom affiché du vault (nom du dossier racine).
pub fn vault_name(root: &Path) -> String {
    root.file_name()
        .map(|name| nfc(&name.to_string_lossy()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Dayali".to_string())
}

/// Crée un dossier (idempotent), avec une erreur IPC stable.
pub fn ensure_dir(dir: &Path) -> Result<(), DayaliError> {
    std::fs::create_dir_all(dir)
        .map_err(|error| DayaliError::from_io(&error, "création de dossier impossible"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    #[test]
    fn accepts_relative_paths_and_normalizes_nfc() {
        assert_eq!(validate_rel_path(".dayali/config.json").unwrap(), ".dayali/config.json");
        assert_eq!(
            validate_rel_path("journal/2026-10-26--2e3f4a5b.md").unwrap(),
            "journal/2026-10-26--2e3f4a5b.md"
        );
        // Nom décomposé (NFD) → composé (NFC).
        assert_eq!(validate_rel_path("projets/e\u{301}te\u{301}.md").unwrap(), "projets/été.md");
    }

    #[test]
    fn rejects_escapes_and_absolute_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "C:/Windows/system32",
            "C:\\Windows",
            "a\\b",
            "../secret",
            "a/../b",
            "a/./b",
            "a//b",
            "a/",
            "./a",
            "a/b/..",
        ] {
            let error = validate_rel_path(bad).unwrap_err();
            assert_eq!(
                error.code,
                crate::error::ErrorCode::PathEscape,
                "chemin accepté à tort : {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_control_chars_and_windows_reserved_names() {
        assert!(validate_rel_path("a\u{0}b").is_err());
        assert!(validate_rel_path("a\nb").is_err());
        assert!(validate_rel_path("dossier/CON").is_err());
        assert!(validate_rel_path("dossier/con.txt").is_err());
        assert!(validate_rel_path("dossier/COM1.json").is_err());
        assert!(validate_rel_path("dossier/LPT9").is_err());
        assert!(validate_rel_path("dossier/COM0").is_ok());
        assert!(validate_rel_path("dossier/console.txt").is_ok());
    }

    #[test]
    fn rejects_names_ending_with_dot_or_space() {
        assert!(validate_rel_path("a/b.").is_err());
        assert!(validate_rel_path("a/b ").is_err());
    }

    #[test]
    fn resolve_write_creates_parents_inside_root() {
        let (_dir, root) = temp_root();
        let resolved = resolve_write(&root, ".dayali/machines/id.json", true).unwrap();
        assert_eq!(resolved.rel_path, ".dayali/machines/id.json");
        assert!(resolved.absolute.starts_with(std::fs::canonicalize(&root).unwrap()));
        assert!(root.join(".dayali/machines").is_dir());
    }

    #[test]
    fn resolve_write_refuses_missing_parent_without_create_parents() {
        let (_dir, root) = temp_root();
        let error = resolve_write(&root, "a/b/c.json", false).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_read_and_write_refuse_symlink_escape() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = temp_root();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "hors vault").unwrap();
        symlink(outside.path(), root.join("lien")).unwrap();

        let read_error = resolve_read(&root, "lien/secret.txt").unwrap_err();
        assert_eq!(read_error.code, crate::error::ErrorCode::PathEscape);

        let write_error = resolve_write(&root, "lien/nouveau.txt", true).unwrap_err();
        assert_eq!(write_error.code, crate::error::ErrorCode::PathEscape);
        assert!(!outside.path().join("nouveau.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_write_refuses_symlinked_file() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = temp_root();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("config.json");
        std::fs::write(&target, "{}").unwrap();
        symlink(&target, root.join("config.json")).unwrap();
        let error = resolve_write(&root, "config.json", false).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::PathEscape);
    }

    #[test]
    fn absolute_display_is_normalized() {
        assert_eq!(normalize_absolute_display(Path::new("/tmp/vault/")), "/tmp/vault");
        assert_eq!(normalize_absolute_display(Path::new("/")), "/");
    }
}

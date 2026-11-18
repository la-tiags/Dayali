//! `.dayali/config.json` — lecture, création et patch avec précondition
//! (PLAN §4.1, §5.4, §6(a)).
//!
//! Règles :
//!  - création avec les défauts exacts, uniquement si le fichier est absent ;
//!  - un `schemaVersion` inconnu est une erreur explicite, jamais une réécriture ;
//!  - un patch exige la révision lue par l'UI ; toute divergence renvoie
//!    `E_PRECONDITION_FAILED` avec l'état courant et n'écrit rien (pas de merge
//!    à trois voies à cette étape) ;
//!  - les copies `.conflict-*` existantes sont signalées, jamais masquées.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{FileRef, Precondition};
use crate::models::config::{is_revision, Config, ConfigSnapshot};
use crate::services;
use crate::vault::{atomic, fs as vault_fs, hash, paths};

/// Chemin relatif canonique du fichier de configuration.
pub const CONFIG_REL_PATH: &str = ".dayali/config.json";
/// Plafond de lecture : une configuration reste un petit document.
pub const MAX_CONFIG_BYTES: usize = 1024 * 1024;

fn file_ref_from_bytes(
    resolved: &paths::ResolvedPath,
    bytes: &[u8],
) -> Result<FileRef, DayaliError> {
    let metadata = std::fs::metadata(&resolved.absolute)
        .map_err(|error| DayaliError::from_io(&error, "métadonnées de config.json illisibles"))?;
    Ok(FileRef {
        rel_path: resolved.rel_path.clone(),
        hash: hash::sha256_bytes(bytes),
        size: bytes.len() as u64,
        mtime: vault_fs::mtime_iso(&metadata)?,
    })
}

/// Lit, parse et valide `config.json`. La révision est le SHA-256 exact des
/// octets lus (pas d'un second passage disque).
pub fn read(root: &Path) -> Result<(Config, FileRef), DayaliError> {
    let resolved = paths::resolve_read(root, CONFIG_REL_PATH)?;
    let bytes = vault_fs::read_bytes_limited(&resolved.absolute, MAX_CONFIG_BYTES)?;
    let text = vault_fs::decode_utf8(&bytes, CONFIG_REL_PATH)?;
    let config: Config = services::parse_json(&text, CONFIG_REL_PATH)?;
    config.validate()?;
    let file_ref = file_ref_from_bytes(&resolved, &bytes)?;
    Ok((config, file_ref))
}

/// Copie de conflit interne la plus récente, si elle existe.
///
/// Dayali ne crée pas de copie sur un simple refus de précondition (aucune
/// écriture n'a lieu) ; il signale en revanche celles déjà présentes sur disque.
pub fn find_conflict_copy(root: &Path) -> Option<String> {
    let entries = std::fs::read_dir(root.join(".dayali")).ok()?;
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("config.conflict-") && name.ends_with(".json"))
        .collect();
    names.sort();
    names.pop().map(|name| format!(".dayali/{name}"))
}

fn make_snapshot(config: Config, revision: String, root: &Path) -> ConfigSnapshot {
    ConfigSnapshot {
        config,
        revision,
        conflict_copy: find_conflict_copy(root),
    }
}

/// Lit la configuration existante et sa révision, sans création implicite.
pub fn snapshot(root: &Path) -> Result<ConfigSnapshot, DayaliError> {
    let (config, file_ref) = read(root)?;
    Ok(make_snapshot(config, file_ref.hash, root))
}

/// Crée `config.json` avec les défauts du schéma, sans écraser un fichier
/// existant (`mustNotExist`).
pub fn create_defaults(root: &Path) -> Result<ConfigSnapshot, DayaliError> {
    let config = Config::default();
    config.validate()?;
    let bytes = config.to_json_bytes()?;
    let written = atomic::write_vault_bytes(
        root,
        CONFIG_REL_PATH,
        &bytes,
        Some(&Precondition::must_not_exist()),
        true,
    )?;
    Ok(make_snapshot(config, written.hash, root))
}

/// Lit la configuration ou la crée si elle est absente.
///
/// Une course avec un autre écrivain se résout par une relecture : le fichier
/// existant n'est jamais remplacé.
pub fn load_or_create(root: &Path) -> Result<ConfigSnapshot, DayaliError> {
    match read(root) {
        Ok((config, file_ref)) => Ok(make_snapshot(config, file_ref.hash, root)),
        Err(error) if error.code == ErrorCode::NotFound => match create_defaults(root) {
            Ok(created) => Ok(created),
            Err(create_error) if create_error.code == ErrorCode::PreconditionFailed => {
                let (config, file_ref) = read(root)?;
                Ok(make_snapshot(config, file_ref.hash, root))
            }
            Err(create_error) => Err(create_error),
        },
        Err(error) => Err(error),
    }
}

/// Applique un patch après vérification stricte de `expectedRevision`.
///
/// Aucune fusion à trois voies : si le fichier a changé, l'UI doit recharger.
pub fn patch(
    root: &Path,
    patch: &Value,
    expected_revision: &str,
) -> Result<ConfigSnapshot, DayaliError> {
    if !is_revision(expected_revision) {
        return Err(DayaliError::schema_invalid(
            "/expectedRevision",
            "expectedRevision : SHA-256 hexadécimal minuscule attendu",
        ));
    }
    if !patch.is_object() {
        return Err(DayaliError::schema_invalid(
            "/patch",
            "le patch de configuration doit être un objet JSON",
        ));
    }

    let (current, current_ref) = read(root)?;
    if current_ref.hash != expected_revision {
        return Err(services::precondition_failed(
            "config.json a changé depuis la lecture : recharge la configuration",
            &current_ref,
        ));
    }

    let mut merged = serde_json::to_value(&current)?;
    services::deep_merge(&mut merged, patch);
    let next: Config = services::parse_json_value(merged, "config.json (patch)")?;
    next.validate()?;

    if next == current {
        return Ok(make_snapshot(current, current_ref.hash, root));
    }

    let bytes = next.to_json_bytes()?;
    let written = atomic::write_vault_bytes(
        root,
        CONFIG_REL_PATH,
        &bytes,
        Some(&Precondition::hash(expected_revision)),
        false,
    )?;
    Ok(make_snapshot(next, written.hash, root))
}

/// Copie de conflit nommée selon la convention du PLAN §4.11.
///
/// Utilisée seulement quand une écriture concurrente doit conserver les deux
/// contenus ; à l'étape (a) le patch refuse sans écrire, mais le nom reste
/// centralisé pour les étapes suivantes.
pub fn conflict_copy_path(machine_id: &str, at: DateTime<Utc>) -> String {
    let machine8 = machine_id.chars().take(8).collect::<String>();
    let stamp = at.format("%Y%m%dT%H%M%S%.3fZ").to_string();
    format!(".dayali/config.conflict-{machine8}-{stamp}.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::common::nfc;

    fn vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".dayali")).unwrap();
        (dir, root)
    }

    #[test]
    fn defaults_match_the_frozen_schema_values() {
        let (_dir, root) = vault();
        let created = create_defaults(&root).unwrap();
        assert_eq!(created.config.day_start_hour, 4);
        assert!(!created.config.open_dashboard_on_launch);
        assert_eq!(created.config.locale, "fr-FR");
        assert_eq!(created.config.week_starts_on, 1);
        assert_eq!(created.revision.len(), 64);

        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(root.join(CONFIG_REL_PATH)).unwrap()).unwrap();
        assert_eq!(on_disk["schemaVersion"], 1);
        assert_eq!(on_disk["dayStartHour"], 4);
        assert_eq!(on_disk["dashboard"]["columns"], 12);
        assert_eq!(on_disk["views"], serde_json::json!([]));
    }

    #[test]
    fn creation_never_overwrites_an_existing_config() {
        let (_dir, root) = vault();
        let path = root.join(CONFIG_REL_PATH);
        std::fs::write(&path, b"{\"contenu\":\"existant\"}").unwrap();
        let error = create_defaults(&root).unwrap_err();
        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"contenu\":\"existant\"}");
    }

    #[test]
    fn load_or_create_is_idempotent_and_keeps_revision() {
        let (_dir, root) = vault();
        let first = load_or_create(&root).unwrap();
        let second = load_or_create(&root).unwrap();
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.config, second.config);
    }

    #[test]
    fn unknown_schema_version_is_refused_without_rewrite() {
        let (_dir, root) = vault();
        let path = root.join(CONFIG_REL_PATH);
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let error = load_or_create(&root).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.unwrap()["path"], "/schemaVersion");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn stale_revision_is_refused_with_current_state_and_no_write() {
        let (_dir, root) = vault();
        let current = load_or_create(&root).unwrap();
        let path = root.join(CONFIG_REL_PATH);
        let before = std::fs::read(&path).unwrap();

        let error = patch(
            &root,
            &serde_json::json!({ "dayStartHour": 6 }),
            &"0".repeat(64),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        let details = error.details.unwrap();
        assert_eq!(details["currentRevision"], current.revision);
        assert_eq!(details["current"]["hash"], current.revision);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn patch_merges_objects_replaces_arrays_and_updates_revision() {
        let (_dir, root) = vault();
        let current = load_or_create(&root).unwrap();
        let patched = patch(
            &root,
            &serde_json::json!({
                "dayStartHour": 5,
                "appearance": { "theme": "dark" }
            }),
            &current.revision,
        )
        .unwrap();

        assert_eq!(patched.config.day_start_hour, 5);
        assert_eq!(patched.config.appearance.theme, crate::models::config::Theme::Dark);
        assert_ne!(patched.revision, current.revision);

        let next = patch(
            &root,
            &serde_json::json!({ "appearance": { "greeting": { "variants": false } } }),
            &patched.revision,
        )
        .unwrap();
        assert!(!next.config.appearance.greeting.variants);
        assert_eq!(next.config.appearance.theme, crate::models::config::Theme::Dark);
    }

    #[test]
    fn patch_rejects_unknown_fields_and_invalid_values() {
        let (_dir, root) = vault();
        let current = load_or_create(&root).unwrap();

        let unknown = patch(
            &root,
            &serde_json::json!({ "champInconnu": true }),
            &current.revision,
        )
        .unwrap_err();
        assert_eq!(unknown.code, ErrorCode::SchemaInvalid);

        let invalid = patch(
            &root,
            &serde_json::json!({ "dayStartHour": 24 }),
            &current.revision,
        )
        .unwrap_err();
        assert_eq!(invalid.code, ErrorCode::SchemaInvalid);
        assert_eq!(invalid.details.unwrap()["path"], "/dayStartHour");
    }

    #[test]
    fn conflict_copies_are_never_hidden() {
        let (_dir, root) = vault();
        let created = load_or_create(&root).unwrap();
        assert_eq!(created.conflict_copy, None);

        let name = "config.conflict-0199a1b2-20261027T024500.000Z.json";
        std::fs::write(root.join(".dayali").join(name), b"{}").unwrap();
        let snapshot = load_or_create(&root).unwrap();
        assert_eq!(snapshot.conflict_copy, Some(format!(".dayali/{name}")));
    }

    #[test]
    fn conflict_copy_name_is_compact_and_machine_scoped() {
        let at = crate::models::common::parse_iso("2026-10-27T02:30:00.000Z").unwrap();
        let name = conflict_copy_path("0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", at);
        assert_eq!(
            name,
            ".dayali/config.conflict-0199a1b2-20261027T023000.000Z.json"
        );
        assert_eq!(nfc(&name), name);
    }
}

//! Ouverture / création / fermeture d'un vault (PLAN §4, §5.2, §6(a)).
//!
//! Deux modes distincts, jamais confondus :
//!  - `open` ouvre un dossier **existant** : le dossier choisi EST la racine du
//!    vault (`.dayali/` va dedans, aucun sous-dossier `<dossier>/<dossier>/`).
//!    `open` ne crée **jamais** la racine : un dossier absent est `E_NOT_FOUND`,
//!    un fichier est `E_SCHEMA_INVALID`. La création est réservée à `create` ;
//!  - `create` crée `<parent>/<name>/` puis ouvre ce dossier ; si l'ouverture
//!    échoue après que `create` a lui-même créé le dossier cible, ce dossier
//!    (et tout ce que l'ouverture interrompue y a écrit) est supprimé.
//!
//! Les deux sont volontairement stricts :
//!  - chemin absolu local uniquement ;
//!  - `.dayali/` et `.dayali/machines/` créés sans traverser de symlink ;
//!  - `config.json` et le fichier machine créés **seulement s'ils manquent** ;
//!  - aucun dossier de module (`calendar/`, `reminders/`, `journal/`,
//!    `projects/`, `quotes/`) n'est créé à cette étape ;
//!  - `machine.json` hors vault n'est mis à jour qu'après réussite.

use std::path::Path;

use chrono::{DateTime, Utc};

use crate::app_state::{AppState, OpenVault};
use crate::error::{DayaliError, ErrorCode};
use crate::models::common::{is_absolute_path, VaultInfo};
use crate::models::machine_local::MachineLocal;
use crate::services::{config, machine};
use crate::vault::paths as vault_paths;

/// Caractères interdits dans le nom d'un vault : séparateurs et caractères
/// réservés par Windows, refusés sur toutes les plateformes (vault portable).
const FORBIDDEN_NAME_CHARS: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Crée un dossier interne du vault sans suivre aucun symlink.
///
/// `create_dir_all` traverserait un `.dayali` symlinké vers l'extérieur ; ce
/// n'est pas acceptable pour un dossier qui contient l'identité et les écritures
/// atomiques.
fn ensure_internal_dir(root: &Path, rel: &str) -> Result<(), DayaliError> {
    let valid = vault_paths::validate_rel_path(rel)?;
    let mut current = root.to_path_buf();
    for segment in valid.split('/') {
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(DayaliError::path_escape(format!(
                        "symlink refusé dans le dossier interne du vault : {}",
                        current.display()
                    )));
                }
                if !metadata.is_dir() {
                    return Err(DayaliError::schema_invalid(
                        "/",
                        "un composant de .dayali n'est pas un dossier",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|create_error| {
                    DayaliError::from_io(&create_error, "création du dossier interne impossible")
                })?;
            }
            Err(error) => {
                return Err(DayaliError::from_io(
                    &error,
                    "dossier interne du vault inaccessible",
                ));
            }
        }
    }
    Ok(())
}

/// Ouvre un vault **existant** et met à jour la mémoire du dernier vault.
///
/// Le dossier désigné doit déjà exister et être un dossier : `open` ne crée
/// jamais la racine (c'est le rôle de [`create`]). Le retour contient le vault
/// prêt à être publié dans `AppState` et la nouvelle valeur de `machine.json`,
/// pour que l'appelant mette les deux à jour sous le même verrou d'écriture.
pub fn open(
    state: &AppState,
    requested_path: &str,
    at: DateTime<Utc>,
) -> Result<(OpenVault, MachineLocal), DayaliError> {
    if requested_path.is_empty() {
        return Err(DayaliError::schema_invalid(
            "/path",
            "aucun dossier de vault sélectionné",
        ));
    }
    if !is_absolute_path(requested_path) {
        return Err(DayaliError::schema_invalid(
            "/path",
            "le vault doit être désigné par un chemin absolu local",
        ));
    }

    let requested = Path::new(requested_path);
    let display_requested = vault_paths::normalize_absolute_display(requested);
    // `metadata` suit les symlinks : choisir `/tmp` (symlink vers `/private/tmp`
    // sur macOS) reste légitime. Seul le dossier canonique compte.
    match std::fs::metadata(requested) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(DayaliError::schema_invalid(
                "/path",
                format!(
                    "« {display_requested} » n'est pas un dossier : « Ouvrir un dossier » \
                     attend un dossier existant."
                ),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(DayaliError::new(
                ErrorCode::NotFound,
                format!(
                    "dossier de vault introuvable : {display_requested}. Utilise « Créer un \
                     vault » pour en créer un."
                ),
            )
            .with_details(serde_json::json!({ "path": display_requested })));
        }
        Err(error) => {
            return Err(DayaliError::from_io(&error, "dossier du vault inaccessible"));
        }
    }

    let root = vault_paths::canonical_root(requested)?;
    let display_root = vault_paths::normalize_absolute_display(&root);
    let name = vault_paths::vault_name(&root);

    ensure_internal_dir(&root, ".dayali")?;
    ensure_internal_dir(&root, ".dayali/machines")?;

    // Les deux créations sont idempotentes et n'écrasent jamais un fichier lu.
    let config_snapshot = config::load_or_create(&root)?;
    let local = state.local()?;
    machine::load_or_create_vault_machine(
        &root,
        &local.machine_id,
        &state.profile,
        at,
        &display_root,
    )?;

    // Dernière étape : une ouverture n'est mémorisée qu'une fois réussie.
    let next_local =
        machine::remember_vault(state.local_path(), &display_root, &local.machine_id)?;

    let open = OpenVault {
        root,
        display_root,
        name,
        machine_id: local.machine_id,
        config_revision: config_snapshot.revision,
    };
    Ok((open, next_local))
}

/// Valide le nom d'un dossier de vault (un seul segment, portable).
///
/// Retourne le nom normalisé NFC, identique au nom réellement créé sur disque.
/// Refuse explicitement les séparateurs et `:*?"<>|` que
/// `validate_rel_path` laisserait passer (`a/b`, `a:b`) : un vault « Créer »
/// n'accepte jamais un chemin, seulement un nom.
fn validate_vault_name(name: &str) -> Result<String, DayaliError> {
    if name.is_empty() {
        return Err(DayaliError::schema_invalid(
            "/name",
            "aucun nom de vault fourni",
        ));
    }
    if name.trim() != name {
        return Err(DayaliError::path_escape(
            "le nom du vault ne peut commencer ni se terminer par un espace",
        )
        .with_details(serde_json::json!({ "path": "/name" })));
    }
    if name.trim().is_empty() {
        return Err(DayaliError::schema_invalid(
            "/name",
            "le nom du vault ne peut pas être composé uniquement d'espaces",
        ));
    }
    if name == "." || name == ".." {
        return Err(DayaliError::path_escape(
            "les noms « . » et « .. » sont interdits",
        )
        .with_details(serde_json::json!({ "path": "/name" })));
    }
    if let Some(character) = name
        .chars()
        .find(|character| FORBIDDEN_NAME_CHARS.contains(character))
    {
        return Err(DayaliError::path_escape(format!(
            "caractère interdit dans le nom du vault : {character:?}"
        ))
        .with_details(serde_json::json!({ "path": "/name" })));
    }
    if name.chars().any(char::is_control) {
        return Err(DayaliError::path_escape(
            "caractère de contrôle interdit dans le nom du vault",
        )
        .with_details(serde_json::json!({ "path": "/name" })));
    }
    if name.len() > vault_paths::MAX_SEGMENT_LEN {
        return Err(DayaliError::path_escape(format!(
            "nom du vault trop long (max {} octets)",
            vault_paths::MAX_SEGMENT_LEN
        ))
        .with_details(serde_json::json!({ "path": "/name" })));
    }
    // Réutilise les règles communes : `.`/`..`, espace ou point final, noms
    // réservés Windows (CON, COM1, LPT9…), NFC.
    vault_paths::validate_rel_path(name)
}

/// Crée `<parent>/<name>/` puis l'ouvre comme vault.
///
/// Ne fait jamais de `create_dir_all` sur un chemin fourni par l'UI : seul
/// `parent` vient de l'utilisateur, `name` est validé comme un unique segment.
/// Un dossier cible existant non vide est refusé sans être touché, pour éviter
/// d'initialiser un vault au milieu de fichiers personnels.
///
/// Si l'ouverture échoue ensuite (`config.json` invalide, état machine cassé,
/// disque plein…), tout ce que `create` a écrit est retiré avant que l'erreur
/// soit propagée : aucun faux vault à moitié initialisé ne subsiste.
///  - dossier cible créé par `create` : il est supprimé entièrement ;
///  - dossier cible préexistant vide : il est conservé tel qu'il a été trouvé,
///    seul le `.dayali/` écrit par l'ouverture interrompue est supprimé (il ne
///    pouvait pas exister puisque le dossier était vide).
pub fn create(
    state: &AppState,
    parent_path: &str,
    name: &str,
    at: DateTime<Utc>,
) -> Result<(OpenVault, MachineLocal), DayaliError> {
    if parent_path.is_empty() {
        return Err(DayaliError::schema_invalid(
            "/parentPath",
            "aucun dossier parent sélectionné",
        ));
    }
    if !is_absolute_path(parent_path) {
        return Err(DayaliError::schema_invalid(
            "/parentPath",
            "le dossier parent doit être désigné par un chemin absolu local",
        ));
    }
    let parent = Path::new(parent_path);
    // `metadata` suit les symlinks : sélectionner `/tmp` (symlink vers
    // `/private/tmp` sur macOS) est légitime, seul le chemin canonique compte.
    let parent_metadata = match std::fs::metadata(parent) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(DayaliError::new(
                ErrorCode::NotFound,
                format!(
                    "dossier parent introuvable : {}",
                    vault_paths::normalize_absolute_display(parent)
                ),
            )
            .with_details(serde_json::json!({ "path": "/parentPath" })));
        }
        Err(error) => {
            return Err(DayaliError::from_io(&error, "dossier parent inaccessible"));
        }
    };
    if !parent_metadata.is_dir() {
        return Err(DayaliError::schema_invalid(
            "/parentPath",
            "le chemin parent n'est pas un dossier",
        ));
    }
    let parent_canonical = std::fs::canonicalize(parent).map_err(|error| {
        DayaliError::from_io(&error, "dossier parent introuvable ou inaccessible")
    })?;

    let name = validate_vault_name(name)?;
    let target = parent_canonical.join(&name);

    let created = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => {
            let display = vault_paths::normalize_absolute_display(&target);
            if metadata.file_type().is_symlink() {
                return Err(DayaliError::path_escape(format!(
                    "un lien symbolique ne peut pas servir de vault : {display}"
                ))
                .with_details(serde_json::json!({ "path": display })));
            }
            if !metadata.is_dir() {
                return Err(DayaliError::new(
                    ErrorCode::PreconditionFailed,
                    format!(
                        "« {display} » existe déjà et n'est pas un dossier ; rien n'a été modifié."
                    ),
                )
                .with_details(serde_json::json!({ "path": display, "reason": "not_a_directory" })));
            }
            let mut entries = std::fs::read_dir(&target)
                .map_err(|error| DayaliError::from_io(&error, "dossier cible inaccessible"))?;
            // Une erreur de lecture d'entrée vaut « non vide » : on n'écrit pas.
            if entries.next().is_some() {
                return Err(DayaliError::new(
                    ErrorCode::PreconditionFailed,
                    format!(
                        "Le dossier « {display} » n'est pas vide. Utilise « Ouvrir un dossier » \
                         pour ouvrir un vault existant ; rien n'a été modifié."
                    ),
                )
                .with_details(serde_json::json!({ "path": display, "reason": "not_empty" })));
            }
            // Dossier existant vide : il appartient à l'utilisateur, `create` ne
            // le supprimera jamais, même si l'ouverture échoue ensuite.
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // `create_dir_all` AVANT `canonicalize` : canonicaliser échoue sur
            // un chemin qui n'existe pas encore.
            std::fs::create_dir_all(&target).map_err(|error| {
                DayaliError::from_io(&error, "création du dossier du vault impossible")
            })?;
            true
        }
        Err(error) => {
            return Err(DayaliError::from_io(&error, "dossier cible inaccessible"));
        }
    };

    // Toute erreur après la création du dossier cible doit le retirer : une
    // création interrompue ne doit pas laisser un faux vault à moitié initialisé
    // que `open` refuserait ensuite (et qu'un `create` relancerait en « non vide »).
    let attempt = (|| -> Result<(OpenVault, MachineLocal), DayaliError> {
        let target_canonical = std::fs::canonicalize(&target)
            .map_err(|error| DayaliError::from_io(&error, "dossier du vault introuvable"))?;
        if !vault_paths::is_inside(&parent_canonical, &target_canonical) {
            return Err(DayaliError::path_escape(
                "le dossier du vault créé sort du dossier parent (symlink ou montage)",
            ));
        }
        let requested = target_canonical.to_str().ok_or_else(|| {
            DayaliError::schema_invalid(
                "/parentPath",
                "chemin du vault non représentable en UTF-8",
            )
        })?;
        open(state, requested, at)
    })();

    match attempt {
        Ok(value) => Ok(value),
        Err(error) => {
            if let Err(cleanup) = discard_created_target(&target, created) {
                // On ne masque pas la cause première, mais on dit que le dossier
                // incomplet est resté : l'utilisateur doit pouvoir le supprimer.
                let mut combined = error;
                combined.message = format!(
                    "{} (nettoyage du dossier de vault incomplet impossible : {})",
                    combined.message, cleanup.message
                );
                return Err(combined);
            }
            Err(error)
        }
    }
}

/// Supprime ce qu'une création interrompue a écrit.
///
///  - `created == true` : le dossier cible n'existait pas avant l'appel, il a
///    été produit uniquement par l'initialisation interrompue (`.dayali/`,
///    `config.json`, fichier machine) ; il est supprimé entièrement.
///  - `created == false` : le dossier cible préexistait **vide** et appartient
///    à l'utilisateur. On retire uniquement `.dayali/`, seul élément que
///    l'ouverture interrompue a pu y créer (le dossier était vide au contrôle
///    précédent). Aucun autre fichier n'est touché, et le dossier cible reste
///    vide comme il a été trouvé.
fn discard_created_target(target: &Path, created: bool) -> Result<(), DayaliError> {
    if created {
        return match std::fs::remove_dir_all(target) {
            Ok(()) => Ok(()),
            // Déjà retiré (ou jamais créé sur ce système) : rien à faire.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(DayaliError::from_io(
                &error,
                "nettoyage du dossier de vault incomplet impossible",
            )),
        };
    }

    // Dossier préexistant vide : `.dayali` n'a pu être créé que par cet appel.
    // On refuse de supprimer autre chose qu'un dossier ordinaire (jamais un
    // symlink, jamais un fichier) pour ne pas détruire une donnée étrangère.
    let internal = target.join(".dayali");
    match std::fs::symlink_metadata(&internal) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(DayaliError::path_escape(format!(
                    "nettoyage refusé : {} n'est pas un dossier ordinaire",
                    internal.display()
                )));
            }
            std::fs::remove_dir_all(&internal).map_err(|error| {
                DayaliError::from_io(
                    &error,
                    "nettoyage du dossier de vault incomplet impossible",
                )
            })
        }
        // Rien n'a été écrit (échec avant `ensure_internal_dir`) : le dossier
        // cible est déjà dans l'état où il a été trouvé.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DayaliError::from_io(
            &error,
            "nettoyage du dossier de vault incomplet impossible",
        )),
    }
}

/// Ferme le vault actif (aucun watcher à arrêter à l'étape (a)).
pub fn close(state: &AppState) -> Result<(), DayaliError> {
    state.replace_vault(None)
}

/// `VaultInfo` avec la révision **recalculée** du `config.json` courant.
///
/// Les autres champs viennent de la session ouverte (racine canonique, nom,
/// identité). Si le fichier a disparu ou est invalide, l'erreur est explicite.
pub fn info(state: &AppState) -> Result<VaultInfo, DayaliError> {
    let (root, display_root, name, machine_id) = state.with_vault(|vault| {
        Ok((
            vault.root.clone(),
            vault.display_root.clone(),
            vault.name.clone(),
            vault.machine_id.clone(),
        ))
    })?;
    let (_, file_ref) = config::read(&root)?;
    Ok(VaultInfo {
        root: display_root,
        name,
        machine_id,
        config_revision: file_ref.hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::LocalSlot;
    use crate::models::common::{parse_iso, AppPaths};
    use crate::models::machine::{Arch, Platform, MachineProfile};

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

    fn app_paths(dir: &Path) -> (AppPaths, std::path::PathBuf) {
        let config_dir = dir.join("app-config");
        let local_path = config_dir.join("machine.json");
        (
            AppPaths {
                config_dir: config_dir.to_string_lossy().to_string(),
                data_dir: dir.join("app-data").to_string_lossy().to_string(),
                cache_dir: dir.join("app-cache").to_string_lossy().to_string(),
                log_dir: dir.join("app-log").to_string_lossy().to_string(),
            },
            local_path,
        )
    }

    fn state_with(dir: &Path, local: LocalSlot) -> AppState {
        let (paths, local_path) = app_paths(dir);
        AppState::new(paths, local_path, profile(), "UTC".to_string(), local)
    }

    fn state(dir: &Path) -> AppState {
        let (_, local_path) = app_paths(dir);
        let (local, _) =
            machine::load_or_init_local(&local_path, parse_iso("2026-10-27T08:00:00.000Z").unwrap())
                .unwrap();
        state_with(dir, LocalSlot::Ready(local))
    }

    /// `machine.json` corrompu : `open` échoue *après* avoir écrit
    /// `.dayali/config.json`, ce qui rend le nettoyage de `create` observable.
    fn broken_state(dir: &Path) -> AppState {
        state_with(
            dir,
            LocalSlot::Broken(DayaliError::schema_invalid(
                "/machineId",
                "machine.json corrompu (test)",
            )),
        )
    }

    #[test]
    fn open_creates_the_minimal_tree_and_no_module_folders() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        // `open` exige un dossier existant : la création est réservée à `create`.
        std::fs::create_dir(&vault_path).unwrap();
        let (open, local) = open(
            &state,
            vault_path.to_str().unwrap(),
            parse_iso("2026-10-27T08:00:00.000Z").unwrap(),
        )
        .unwrap();

        assert_eq!(open.name, "MonVault");
        assert_eq!(open.machine_id, state.local().unwrap().machine_id);
        assert!(vault_path.join(".dayali/config.json").is_file());
        assert!(vault_path
            .join(format!(".dayali/machines/{}.json", open.machine_id))
            .is_file());
        for module in ["calendar", "reminders", "journal", "projects", "quotes"] {
            assert!(!vault_path.join(module).exists(), "dossier {module} créé à tort");
        }
        assert_eq!(local.recent_vaults[0], open.display_root);
        assert_eq!(local.last_vault_path.as_deref(), Some(open.display_root.as_str()));
    }

    #[test]
    fn reopening_never_overwrites_config_or_machine_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        std::fs::create_dir(&vault_path).unwrap();
        let at = parse_iso("2026-10-27T08:00:00.000Z").unwrap();

        let (first, _) = open(&state, vault_path.to_str().unwrap(), at).unwrap();
        let config_path = vault_path.join(".dayali/config.json");
        let machine_path = vault_path.join(format!(".dayali/machines/{}.json", first.machine_id));
        let config_before = std::fs::read(&config_path).unwrap();
        let machine_before = std::fs::read(&machine_path).unwrap();

        let (second, local) = open(&state, vault_path.to_str().unwrap(), at).unwrap();
        assert_eq!(second.machine_id, first.machine_id);
        assert_eq!(second.config_revision, first.config_revision);
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(std::fs::read(&machine_path).unwrap(), machine_before);
        assert_eq!(local.recent_vaults[0], first.display_root);
        assert_eq!(local.recent_vaults.len(), 1);
    }

    #[test]
    fn relative_or_empty_paths_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let at = parse_iso("2026-10-27T08:00:00.000Z").unwrap();
        assert_eq!(
            open(&state, "MonVault", at).unwrap_err().details.unwrap()["path"],
            "/path"
        );
        assert_eq!(
            open(&state, "", at).unwrap_err().details.unwrap()["path"],
            "/path"
        );
    }

    #[test]
    fn open_refuses_a_missing_folder_without_creating_it() {
        let (_state_dir, parent_dir, state) = harness();
        let missing = parent_dir.path().join("Absent");

        let error = open(&state, missing.to_str().unwrap(), at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(error.details.clone().unwrap()["path"], display(&missing));
        assert!(!missing.exists(), "open a créé le dossier absent");
        assert!(entries(parent_dir.path()).is_empty());
        assert!(state.local().unwrap().recent_vaults.is_empty());
    }

    #[test]
    fn open_refuses_a_file_and_leaves_it_intact() {
        let (_state_dir, parent_dir, state) = harness();
        let file = parent_dir.path().join("pas-un-dossier");
        std::fs::write(&file, b"contenu").unwrap();

        let error = open(&state, file.to_str().unwrap(), at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/path");
        assert_eq!(std::fs::read(&file).unwrap(), b"contenu");
        assert_eq!(entries(parent_dir.path()), vec!["pas-un-dossier".to_string()]);
        assert!(state.local().unwrap().recent_vaults.is_empty());
    }

    #[test]
    fn unknown_config_version_blocks_open_without_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        std::fs::create_dir_all(vault_path.join(".dayali")).unwrap();
        let config_path = vault_path.join(".dayali/config.json");
        let mut value = serde_json::to_value(crate::models::config::Config::default()).unwrap();
        value["schemaVersion"] =
            serde_json::json!(crate::models::config::CONFIG_SCHEMA_VERSION + 1);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(&config_path, &bytes).unwrap();

        let error = open(
            &state,
            vault_path.to_str().unwrap(),
            parse_iso("2026-10-27T08:00:00.000Z").unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::SchemaInvalid);
        assert_eq!(
            error.details.unwrap()["path"],
            "/schemaVersion"
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), bytes);
        let local = state.local().unwrap();
        assert_eq!(local.recent_vaults, Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_internal_folder_is_refused() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(&vault_path).unwrap();
        symlink(outside.path(), vault_path.join(".dayali")).unwrap();

        let error = open(
            &state,
            vault_path.to_str().unwrap(),
            parse_iso("2026-10-27T08:00:00.000Z").unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::PathEscape);
        assert!(!outside.path().join("config.json").exists());
    }

    #[test]
    fn info_recomputes_config_revision() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        std::fs::create_dir(&vault_path).unwrap();
        let at = parse_iso("2026-10-27T08:00:00.000Z").unwrap();
        let (open, _) = open(&state, vault_path.to_str().unwrap(), at).unwrap();
        state.replace_vault(Some(open.clone())).unwrap();

        let before = info(&state).unwrap();
        assert_eq!(before.config_revision, open.config_revision);

        let config_path = vault_path.join(".dayali/config.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        value["dayStartHour"] = serde_json::json!(6);
        std::fs::write(&config_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

        let after = info(&state).unwrap();
        assert_ne!(after.config_revision, before.config_revision);
        assert_eq!(after.root, before.root);
    }

    #[test]
    fn close_clears_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let vault_path = dir.path().join("MonVault");
        std::fs::create_dir(&vault_path).unwrap();
        let at = parse_iso("2026-10-27T08:00:00.000Z").unwrap();
        let (open, _) = open(&state, vault_path.to_str().unwrap(), at).unwrap();
        state.replace_vault(Some(open)).unwrap();
        close(&state).unwrap();
        assert_eq!(
            info(&state).unwrap_err().code,
            crate::error::ErrorCode::VaultNotOpen
        );
    }

    // --- Mode « Créer un vault » (parent + nom) ---------------------------

    /// Dossier d'état applicatif et dossier parent distincts : le parent reste
    /// vide au départ, ce qui permet de prouver qu'aucun dossier parasite n'est
    /// créé à côté du vault.
    fn harness() -> (tempfile::TempDir, tempfile::TempDir, AppState) {
        let state_dir = tempfile::tempdir().unwrap();
        let parent_dir = tempfile::tempdir().unwrap();
        let state = state(state_dir.path());
        (state_dir, parent_dir, state)
    }

    fn at() -> DateTime<Utc> {
        parse_iso("2026-10-27T08:00:00.000Z").unwrap()
    }

    fn display(path: &Path) -> String {
        vault_paths::normalize_absolute_display(path)
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn create_builds_parent_name_tree_and_nothing_else() {
        let (_state_dir, parent_dir, state) = harness();
        let parent = parent_dir.path().to_str().unwrap();
        let (open, local) = create(&state, parent, "MonVault", at()).unwrap();

        let target = parent_dir.path().join("MonVault");
        let target_canonical = std::fs::canonicalize(&target).unwrap();
        assert!(target.is_dir());
        assert_eq!(open.name, "MonVault");
        assert_eq!(open.root, target_canonical);
        assert_eq!(open.machine_id, state.local().unwrap().machine_id);
        assert!(target.join(".dayali/config.json").is_file());
        assert!(target
            .join(format!(".dayali/machines/{}.json", open.machine_id))
            .is_file());
        for module in ["calendar", "reminders", "journal", "projects", "quotes"] {
            assert!(!target.join(module).exists(), "dossier {module} créé à tort");
        }
        // Aucun dossier frère, aucune imbrication `<nom>/<nom>/`.
        assert_eq!(entries(parent_dir.path()), vec!["MonVault".to_string()]);
        assert!(!target.join("MonVault").exists());
        assert_eq!(local.recent_vaults[0], open.display_root);
        assert_eq!(local.last_vault_path.as_deref(), Some(open.display_root.as_str()));
    }

    #[test]
    fn create_accepts_an_existing_empty_folder() {
        let (_state_dir, parent_dir, state) = harness();
        let target = parent_dir.path().join("MonVault");
        std::fs::create_dir(&target).unwrap();

        let (open, _) = create(&state, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap();
        assert_eq!(open.name, "MonVault");
        assert!(target.join(".dayali/config.json").is_file());
        assert_eq!(entries(parent_dir.path()), vec!["MonVault".to_string()]);
    }

    #[test]
    fn create_removes_the_target_folder_when_open_fails() {
        let (state_dir, parent_dir, _) = harness();
        // `Broken` fait échouer `open` juste après l'écriture de `config.json`.
        let broken = broken_state(state_dir.path());
        let target = parent_dir.path().join("MonVault");

        let error =
            create(&broken, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/machineId");
        assert!(
            !target.exists(),
            "le dossier cible d'une création interrompue doit être supprimé"
        );
        assert!(entries(parent_dir.path()).is_empty());
    }

    #[test]
    fn create_keeps_a_pre_existing_empty_target_when_open_fails() {
        let (state_dir, parent_dir, _) = harness();
        let broken = broken_state(state_dir.path());
        let target = parent_dir.path().join("MonVault");
        std::fs::create_dir(&target).unwrap();

        let error =
            create(&broken, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert!(
            target.is_dir(),
            "un dossier existant vide ne doit jamais être supprimé par create"
        );
        assert!(
            entries(&target).is_empty(),
            "un dossier existant vide doit rester vide : {}",
            entries(&target).join(", ")
        );
        assert_eq!(entries(parent_dir.path()), vec!["MonVault".to_string()]);

        // Preuve de bout en bout : l'état incomplet a bien été retiré, un
        // second `create` sur le même dossier vide réussit (sinon il serait
        // refusé comme « non vide » à cause du `.dayali` partiel).
        let restarted = state(state_dir.path());
        let (open, _) =
            create(&restarted, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap();
        assert_eq!(open.name, "MonVault");
        assert!(target.join(".dayali/config.json").is_file());
    }

    #[test]
    fn discard_created_target_only_removes_what_create_built() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("incomplet");
        std::fs::create_dir_all(target.join(".dayali/machines")).unwrap();
        std::fs::write(target.join(".dayali/config.json"), b"{}").unwrap();
        // Témoin utilisateur : jamais touché par un nettoyage `created=false`.
        std::fs::write(target.join("temoins.txt"), b"a conserver").unwrap();

        discard_created_target(&target, false).unwrap();
        assert!(target.is_dir(), "created=false ne doit pas supprimer le dossier");
        assert!(
            !target.join(".dayali").exists(),
            "created=false doit retirer le .dayali écrit par l'ouverture interrompue"
        );
        // Un fichier étranger présent n'est pas supprimé (même s'il n'aurait pas
        // dû exister dans un dossier vide : le nettoyage reste conservateur).
        assert_eq!(entries(&target), vec!["temoins.txt".to_string()]);
        // Idempotent : plus rien à retirer.
        discard_created_target(&target, false).unwrap();
        assert_eq!(entries(&target), vec!["temoins.txt".to_string()]);

        discard_created_target(&target, true).unwrap();
        assert!(!target.exists());
        // Idempotent : une création déjà nettoyée n'échoue pas.
        discard_created_target(&target, true).unwrap();
    }

    #[test]
    fn created_vault_can_be_reopened_after_restart_without_rewrite() {
        let (state_dir, parent_dir, initial_state) = harness();
        let (first, _) = create(&initial_state, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap();
        drop(initial_state);

        let target = parent_dir.path().join("MonVault");
        let config_path = target.join(".dayali/config.json");
        let config_before = std::fs::read(&config_path).unwrap();

        // Redémarrage simulé : nouvel état, même dossier de configuration.
        let restarted = state(state_dir.path());
        let (second, _) = open(&restarted, first.display_root.as_str(), at()).unwrap();
        assert_eq!(second.machine_id, first.machine_id);
        assert_eq!(second.name, "MonVault");
        assert_eq!(second.root, first.root);
        assert_eq!(second.config_revision, first.config_revision);
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert!(target.join(".dayali").is_dir());
        assert!(!target.join("MonVault").exists());
    }

    // --- Mode « Ouvrir un dossier » (le dossier choisi EST le vault) -------

    #[test]
    fn open_uses_the_chosen_existing_folder_as_vault_root() {
        let (_state_dir, parent_dir, state) = harness();
        let vault_path = parent_dir.path().join("MonVaultChoisi");
        std::fs::create_dir(&vault_path).unwrap();

        let (open, _) = open(&state, vault_path.to_str().unwrap(), at()).unwrap();

        assert!(vault_path.join(".dayali").is_dir(), ".dayali doit exister");
        assert!(
            vault_path.join(".dayali/machines").is_dir(),
            ".dayali/machines doit exister"
        );
        for module in ["calendar", "reminders", "journal", "projects", "quotes"] {
            assert!(!vault_path.join(module).exists(), "dossier {module} créé à tort");
        }
        assert_eq!(open.name, "MonVaultChoisi");
        // Le dossier choisi EST le vault : pas de `<dossier>/<dossier>/`.
        assert!(!vault_path.join("MonVaultChoisi").exists());
        assert_eq!(entries(parent_dir.path()), vec!["MonVaultChoisi".to_string()]);
    }

    // --- Refus : aucun effet de bord disque -------------------------------

    #[test]
    fn create_rejects_invalid_names_without_creating_anything() {
        let (_state_dir, parent_dir, state) = harness();
        let parent = parent_dir.path().to_str().unwrap();
        let bad_names = [
            "", "   ", "a/b", "a\\b", "..", ".", "Travail ", "Travail.", "CON", "a:b", "a*b",
            "a?b", "a\"b", "a<b", "a>b", "a|b", "a\nb",
        ];
        for name in bad_names {
            let error = match create(&state, parent, name, at()) {
                Ok(_) => panic!("nom accepté à tort : {name:?}"),
                Err(error) => error,
            };
            assert!(
                matches!(error.code, ErrorCode::PathEscape | ErrorCode::SchemaInvalid),
                "code inattendu pour {name:?} : {:?}",
                error.code
            );
            assert!(!error.message.is_empty(), "message absent pour {name:?}");
            assert!(
                entries(parent_dir.path()).is_empty(),
                "le nom {name:?} a créé {}",
                entries(parent_dir.path()).join(", ")
            );
        }
        assert!(state.local().unwrap().recent_vaults.is_empty());
    }

    #[test]
    fn create_refuses_a_non_empty_folder_without_modification() {
        let (_state_dir, parent_dir, state) = harness();
        let target = parent_dir.path().join("MonVault");
        std::fs::create_dir(&target).unwrap();
        let witness = target.join("temoins.txt");
        std::fs::write(&witness, "à conserver").unwrap();

        let error = create(&state, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert!(
            error.message.contains("Ouvrir un dossier"),
            "message sans renvoi vers l'ouverture : {}",
            error.message
        );
        let details = error.details.clone().unwrap();
        assert_eq!(details["reason"], "not_empty");
        let target_display =
            display(&std::fs::canonicalize(parent_dir.path()).unwrap().join("MonVault"));
        assert_eq!(details["path"], target_display);
        assert_eq!(std::fs::read(&witness).unwrap(), "à conserver".as_bytes());
        assert_eq!(entries(&target), vec!["temoins.txt".to_string()]);
        assert!(!target.join(".dayali").exists(), ".dayali ajouté à tort");
        assert!(state.local().unwrap().recent_vaults.is_empty());
    }

    #[test]
    fn create_refuses_a_target_that_is_a_file() {
        let (_state_dir, parent_dir, state) = harness();
        let target = parent_dir.path().join("MonVault");
        std::fs::write(&target, "fichier existant").unwrap();

        let error = create(&state, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::PreconditionFailed);
        assert_eq!(error.details.clone().unwrap()["reason"], "not_a_directory");
        assert_eq!(std::fs::read(&target).unwrap(), "fichier existant".as_bytes());
        assert_eq!(entries(parent_dir.path()), vec!["MonVault".to_string()]);
    }

    #[test]
    fn create_refuses_a_missing_parent_and_creates_nothing() {
        let (_state_dir, parent_dir, state) = harness();
        let missing = parent_dir.path().join("absent").join("sous-dossier");

        let error = create(&state, missing.to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(!missing.exists());
        assert!(!parent_dir.path().join("absent").exists());
        assert!(entries(parent_dir.path()).is_empty());
        assert!(state.local().unwrap().recent_vaults.is_empty());
    }

    #[test]
    fn create_rejects_empty_relative_or_file_parent_paths() {
        let (_state_dir, parent_dir, state) = harness();
        let file_parent = parent_dir.path().join("un-fichier");
        std::fs::write(&file_parent, "x").unwrap();

        for parent in ["", "MonVault", "~/Dayali", "https://example.org/vault"] {
            let error = create(&state, parent, "MonVault", at()).unwrap_err();
            assert_eq!(error.code, ErrorCode::SchemaInvalid, "parent accepté : {parent:?}");
            assert_eq!(error.details.clone().unwrap()["path"], "/parentPath");
        }
        let error = create(&state, file_parent.to_str().unwrap(), "MonVault", at()).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(error.details.clone().unwrap()["path"], "/parentPath");
        assert_eq!(entries(parent_dir.path()), vec!["un-fichier".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn create_refuses_a_symlinked_target_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let (_state_dir, parent_dir, state) = harness();
        let outside = tempfile::tempdir().unwrap();
        let target = parent_dir.path().join("MonVault");
        symlink(outside.path(), &target).unwrap();

        let error = create(&state, parent_dir.path().to_str().unwrap(), "MonVault", at()).unwrap_err();

        assert_eq!(error.code, ErrorCode::PathEscape);
        assert!(!outside.path().join(".dayali").exists());
        assert!(std::fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(entries(parent_dir.path()), vec!["MonVault".to_string()]);
    }
}

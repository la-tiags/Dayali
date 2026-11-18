//! État partagé de l'application (PLAN §5.2, §5.9).
//!
//! Un seul vault est actif à la fois. Les commandes Tauri sont synchrones : les
//! verrous `std` ne traversent donc jamais un `await`, et toutes les écritures
//! d'un même processus sont sérialisées par `writes` (verrou intra-processus).
//! Le verrou inter-processus et le watcher sont explicitement hors périmètre (a).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, RwLock};

use crate::error::DayaliError;
use crate::models::common::{AppPaths, VaultInfo};
use crate::models::machine::MachineProfile;
use crate::models::machine_local::MachineLocal;

/// Vault ouvert et ses métadonnées vérifiées.
#[derive(Debug, Clone)]
pub struct OpenVault {
    /// Racine canonique (symlinks de la racine résolus).
    pub root: PathBuf,
    /// Forme d'affichage NFC du chemin choisi par l'utilisateur.
    pub display_root: String,
    pub name: String,
    pub machine_id: String,
    /// Hash du `config.json` au moment de l'ouverture (recalculé à chaque lecture).
    pub config_revision: String,
}

impl OpenVault {
    pub fn info(&self) -> VaultInfo {
        VaultInfo {
            root: self.display_root.clone(),
            name: self.name.clone(),
            machine_id: self.machine_id.clone(),
            config_revision: self.config_revision.clone(),
        }
    }
}

/// `machine.json` chargé au démarrage. Une corruption est une erreur explicite
/// conservée jusqu'à ce que l'utilisateur la corrige : jamais de réécriture.
#[derive(Debug)]
pub enum LocalSlot {
    Ready(MachineLocal),
    Broken(DayaliError),
}

pub struct AppState {
    pub paths: AppPaths,
    pub local_path: PathBuf,
    pub profile: MachineProfile,
    /// Fuseau IANA de la machine, validé au démarrage (repli `UTC`).
    pub time_zone: String,
    local: Mutex<LocalSlot>,
    vault: RwLock<Option<OpenVault>>,
    writes: Mutex<()>,
}

impl AppState {
    pub fn new(
        paths: AppPaths,
        local_path: PathBuf,
        profile: MachineProfile,
        time_zone: String,
        local: LocalSlot,
    ) -> Self {
        Self {
            paths,
            local_path,
            profile,
            time_zone,
            local: Mutex::new(local),
            vault: RwLock::new(None),
            writes: Mutex::new(()),
        }
    }

    /// Sérialise les read-modify-write d'un même processus.
    pub fn lock_writes(&self) -> Result<MutexGuard<'_, ()>, DayaliError> {
        self.writes
            .lock()
            .map_err(|_| DayaliError::internal("verrou d'écriture empoisonné"))
    }

    pub fn local(&self) -> Result<MachineLocal, DayaliError> {
        let guard = self
            .local
            .lock()
            .map_err(|_| DayaliError::internal("état machine empoisonné"))?;
        match &*guard {
            LocalSlot::Ready(local) => Ok(local.clone()),
            LocalSlot::Broken(error) => Err(error.clone()),
        }
    }

    pub fn local_path(&self) -> &Path {
        &self.local_path
    }

    pub fn set_local(&self, local: MachineLocal) -> Result<(), DayaliError> {
        let mut guard = self
            .local
            .lock()
            .map_err(|_| DayaliError::internal("état machine empoisonné"))?;
        *guard = LocalSlot::Ready(local);
        Ok(())
    }

    pub fn vault_info(&self) -> Result<VaultInfo, DayaliError> {
        self.with_vault(|vault| Ok(vault.info()))
    }

    pub fn with_vault<T>(
        &self,
        action: impl FnOnce(&OpenVault) -> Result<T, DayaliError>,
    ) -> Result<T, DayaliError> {
        let guard = self
            .vault
            .read()
            .map_err(|_| DayaliError::internal("état du vault empoisonné"))?;
        match guard.as_ref() {
            Some(vault) => action(vault),
            None => Err(DayaliError::vault_not_open()),
        }
    }

    pub fn replace_vault(&self, vault: Option<OpenVault>) -> Result<(), DayaliError> {
        let mut guard = self
            .vault
            .write()
            .map_err(|_| DayaliError::internal("état du vault empoisonné"))?;
        *guard = vault;
        Ok(())
    }

    pub fn app_version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::machine::{Arch, Platform};

    fn state(local: LocalSlot) -> AppState {
        AppState::new(
            AppPaths {
                config_dir: "/tmp/dayali-config".to_string(),
                data_dir: "/tmp/dayali-data".to_string(),
                cache_dir: "/tmp/dayali-cache".to_string(),
                log_dir: "/tmp/dayali-log".to_string(),
            },
            PathBuf::from("/tmp/dayali-config/machine.json"),
            MachineProfile {
                name: "Test".to_string(),
                platform: Platform::Macos,
                arch: Arch::Arm64,
                hostname: None,
                os_version: None,
                app_version: "0.1.0".to_string(),
            },
            "Europe/Paris".to_string(),
            local,
        )
    }

    fn local() -> MachineLocal {
        MachineLocal::new(
            "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b".to_string(),
            "2026-10-20T07:05:00.000Z".to_string(),
        )
    }

    #[test]
    fn vault_is_absent_until_replaced_and_cleared() {
        let state = state(LocalSlot::Ready(local()));
        assert_eq!(
            state.vault_info().unwrap_err().code,
            crate::error::ErrorCode::VaultNotOpen
        );

        state
            .replace_vault(Some(OpenVault {
                root: PathBuf::from("/tmp/vault"),
                display_root: "/tmp/vault".to_string(),
                name: "vault".to_string(),
                machine_id: local().machine_id,
                config_revision: "a".repeat(64),
            }))
            .unwrap();
        let info = state.vault_info().unwrap();
        assert_eq!(info.machine_id, local().machine_id);
        assert_eq!(info.root, "/tmp/vault");

        state.replace_vault(None).unwrap();
        assert_eq!(
            state.vault_info().unwrap_err().code,
            crate::error::ErrorCode::VaultNotOpen
        );
    }

    #[test]
    fn broken_local_state_is_reported_not_hidden() {
        let state = state(LocalSlot::Broken(DayaliError::schema_invalid(
            "/machineId",
            "machineId invalide",
        )));
        let error = state.local().unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::SchemaInvalid);
        assert_eq!(error.details.unwrap()["path"], "/machineId");
    }

    #[test]
    fn write_lock_serializes_and_recovers_after_release() {
        let state = state(LocalSlot::Ready(local()));
        {
            let _guard = state.lock_writes().unwrap();
        }
        assert!(state.lock_writes().is_ok());
    }
}

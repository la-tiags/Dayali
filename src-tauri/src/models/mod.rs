//! Modèles Rust du contrat persisté.
//!
//! Les modules ci-dessous sont les types d'exécution de l'étape (a) : ils portent
//! les invariants que JSON Schema ne peut pas exprimer et restent l'autorité de
//! validation côté Rust.
//!
//! `generated.rs` (typify) est produit par `pnpm generate:contracts` depuis les
//! quatre schémas gelés (`common`, `machine-local`, `config`, `machine`). Le
//! script exige `cargo typify` (`cargo install cargo-typify`) ; le mode
//! `--check` compare les sorties commitées et échoue en cas de dérive. Tant que
//! la toolchain Rust n'a pas produit ce fichier, il n'est pas déclaré ici : les
//! types manuels ci-dessus sont la seule source compilée.

pub mod calendar;
pub mod common;
pub mod config;
pub mod day;
pub mod machine;
pub mod machine_local;
pub mod reminders;

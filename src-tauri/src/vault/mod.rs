//! Accès disque du vault : chemins validés, hash, lecture, écriture atomique.
//!
//! Toute la logique fichier vit ici (PLAN §1.7). Aucune commande IPC générique
//! `read_file`/`write_file` n'est exposée : les commandes nommées passent par ces
//! fonctions, qui valident le chemin et vérifient les empreintes.

pub mod atomic;
pub mod fs;
pub mod hash;
pub mod paths;

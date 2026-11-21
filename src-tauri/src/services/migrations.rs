//! Migrations de schéma du vault.
//!
//! Principe : à la lecture, un fichier persisté d'une version antérieure est
//! **migré** (jamais rejeté) puis réécrit atomiquement après sauvegarde de
//! l'original. Un fichier d'une version plus récente est refusé explicitement.
//!
//! Chaque évolution de schéma ajoute une étape numérotée ici et incrémente la
//! constante de version du modèle concerné. Les migrations travaillent sur le
//! JSON brut : elles doivent rester valables même si le modèle Rust a changé.

use serde_json::{json, Value};

use crate::error::{DayaliError, ErrorCode};
use crate::models::config::CONFIG_SCHEMA_VERSION;

/// Trace d'une migration appliquée (pour les logs et les tests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub from: u32,
    pub to: u32,
    pub steps: Vec<&'static str>,
}

/// Applique les migrations de `config.json` jusqu'à la version courante.
///
/// `Ok(None)` si le fichier est déjà à jour. Ne touche pas au disque : la
/// sauvegarde et l'écriture atomique sont faites par `services::config::read`.
pub fn migrate_config(value: &mut Value) -> Result<Option<MigrationReport>, DayaliError> {
    let from = read_version(value)?;
    if from == CONFIG_SCHEMA_VERSION {
        return Ok(None);
    }
    if from > CONFIG_SCHEMA_VERSION {
        return Err(DayaliError::schema_invalid(
            "/schemaVersion",
            format!(
                "Ce vault a été créé par une version plus récente de Dayali \
                 (schéma {from}, cette version lit le schéma {CONFIG_SCHEMA_VERSION}). \
                 Mets Dayali à jour : aucune écriture n'a été faite."
            ),
        ));
    }

    let mut version = from;
    let mut steps = Vec::new();
    while version < CONFIG_SCHEMA_VERSION {
        match version {
            1 => {
                migrate_config_v1_to_v2(value);
                steps.push("config v1 → v2 : photo d'accueil normalisée");
                version = 2;
            }
            other => {
                return Err(DayaliError::new(
                    ErrorCode::Internal,
                    format!("Aucune migration connue depuis le schéma {other}."),
                ));
            }
        }
    }

    value["schemaVersion"] = json!(version);
    Ok(Some(MigrationReport {
        from,
        to: version,
        steps,
    }))
}

fn read_version(value: &Value) -> Result<u32, DayaliError> {
    let Some(version) = value.get("schemaVersion") else {
        // Vault antérieur au versionnement : traité comme la version 1.
        return Ok(1);
    };
    version
        .as_u64()
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| {
            DayaliError::schema_invalid("/schemaVersion", "schemaVersion attendu : entier positif")
        })
}

/// v1 → v2 : `unsplashQuery` n'est plus couplé au mode.
///
/// - un ancien identifiant de photo (hack de la première implémentation) est
///   remplacé par `null` (= « landscape ») ;
/// - hors mode Unsplash, la valeur est effacée ;
/// - les champs manquants de `homeImage` reprennent leurs défauts.
fn migrate_config_v1_to_v2(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    let Some(appearance) = root
        .get_mut("appearance")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let image = appearance
        .entry("homeImage")
        .or_insert_with(|| json!({}));
    let Some(image) = image.as_object_mut() else {
        return;
    };

    let mode = image
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("bundled");
    let query = image.get("unsplashQuery").and_then(Value::as_str);
    let legacy_or_empty = query.is_some_and(|value| {
        value.trim().is_empty() || looks_like_legacy_photo_id(value)
    });
    if mode != "unsplash" || legacy_or_empty {
        image.insert("unsplashQuery".to_string(), Value::Null);
    }

    image
        .entry("mode")
        .or_insert_with(|| json!("bundled"));
    image
        .entry("unsplashQuery")
        .or_insert(Value::Null);
    image
        .entry("showCredit")
        .or_insert_with(|| json!(true));
    image.entry("dim").or_insert_with(|| json!(0.35));
}

/// Ancien format : `unsplashQuery` contenait l'identifiant d'une photo
/// (`1511497584788-87676104235f`), pas des mots-clés.
fn looks_like_legacy_photo_id(value: &str) -> bool {
    let value = value.trim();
    let Some((prefix, suffix)) = value.split_once('-') else {
        return false;
    };
    prefix.len() >= 10
        && prefix.bytes().all(|byte| byte.is_ascii_digit())
        && suffix.len() >= 6
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v1_config(home_image: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "appearance": { "homeImage": home_image }
        })
    }

    #[test]
    fn current_version_is_untouched() {
        let mut value = json!({ "schemaVersion": CONFIG_SCHEMA_VERSION });
        assert!(migrate_config(&mut value).unwrap().is_none());
        assert_eq!(value["schemaVersion"], CONFIG_SCHEMA_VERSION);
    }

    #[test]
    fn missing_version_is_treated_as_v1() {
        let mut value = json!({ "appearance": { "homeImage": { "mode": "unsplash" } } });
        let report = migrate_config(&mut value).unwrap().unwrap();
        assert_eq!(report.from, 1);
        assert_eq!(report.to, CONFIG_SCHEMA_VERSION);
        assert_eq!(value["schemaVersion"], CONFIG_SCHEMA_VERSION);
        assert_eq!(value["appearance"]["homeImage"]["unsplashQuery"], Value::Null);
    }

    #[test]
    fn unsplash_mode_without_query_is_valid_and_kept_null() {
        let mut value = v1_config(json!({ "mode": "unsplash", "unsplashQuery": null }));
        migrate_config(&mut value).unwrap();
        assert_eq!(value["appearance"]["homeImage"]["unsplashQuery"], Value::Null);
        assert_eq!(value["appearance"]["homeImage"]["showCredit"], true);
        assert_eq!(value["appearance"]["homeImage"]["dim"], 0.35);
    }

    #[test]
    fn legacy_photo_id_becomes_null() {
        let mut value = v1_config(json!({
            "mode": "unsplash",
            "unsplashQuery": "1511497584788-87676104235f"
        }));
        migrate_config(&mut value).unwrap();
        assert_eq!(value["appearance"]["homeImage"]["unsplashQuery"], Value::Null);
    }

    #[test]
    fn real_keywords_are_preserved() {
        let mut value = v1_config(json!({
            "mode": "unsplash",
            "unsplashQuery": "landscape mountains lake"
        }));
        migrate_config(&mut value).unwrap();
        assert_eq!(
            value["appearance"]["homeImage"]["unsplashQuery"],
            "landscape mountains lake"
        );
    }

    #[test]
    fn an_empty_query_becomes_null() {
        let mut value = v1_config(json!({ "mode": "unsplash", "unsplashQuery": "   " }));
        migrate_config(&mut value).unwrap();
        assert_eq!(value["appearance"]["homeImage"]["unsplashQuery"], Value::Null);
    }

    #[test]
    fn bundled_mode_clears_the_unused_query() {
        let mut value = v1_config(json!({ "mode": "bundled", "unsplashQuery": "mountains" }));
        migrate_config(&mut value).unwrap();
        assert_eq!(value["appearance"]["homeImage"]["unsplashQuery"], Value::Null);
    }

    #[test]
    fn future_version_is_refused_without_writing() {
        let mut value = json!({ "schemaVersion": CONFIG_SCHEMA_VERSION + 1 });
        let error = migrate_config(&mut value).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert!(error.message.contains("plus récente"));
        assert_eq!(value["schemaVersion"], CONFIG_SCHEMA_VERSION + 1);
    }

    #[test]
    fn invalid_version_type_is_refused() {
        let mut value = json!({ "schemaVersion": "deux" });
        assert!(migrate_config(&mut value).is_err());
    }
}

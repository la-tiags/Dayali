//! Photo d'accueil Unsplash (mode en ligne, optionnel).
//!
//! La clé API est celle de l'application : compilée dans le binaire, elle
//! reste **côté Rust** et n'est jamais sérialisée vers l'UI. L'utilisateur
//! n'a rien à configurer. Aucune image n'est mise en cache
//! (règle Unsplash) : seules les métadonnées (id, URL, crédit) sont conservées
//! pour garder une photo stable pendant la journée logique et ne jamais répéter
//! un id. Hors ligne, l'UI retombe sur les photos Wikimedia embarquées.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::NaiveDate;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::error::{DayaliError, ErrorCode};
use crate::services::home_photo_history;

const API_BASE: &str = "https://api.unsplash.com";
const DEFAULT_QUERY: &str = "landscape";
const HISTORY_MAX: usize = 200;
const DAYS_MAX: usize = 60;
const ATTEMPTS: usize = 8;

/// Métadonnées d'une photo renvoyées à l'UI (jamais de clé, jamais d'octets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePhoto {
    pub id: String,
    pub src: String,
    pub credit: String,
    pub username: String,
    pub source: String,
    pub license: String,
    pub license_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct History {
    ids: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DayCache {
    photos: BTreeMap<String, HomePhoto>,
}

#[derive(Debug, Deserialize)]
struct ApiPhoto {
    id: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    alt_description: Option<String>,
    urls: ApiUrls,
    links: ApiLinks,
    user: ApiUser,
}

#[derive(Debug, Deserialize)]
struct ApiUrls {
    raw: String,
}

#[derive(Debug, Deserialize)]
struct ApiLinks {
    download_location: String,
}

#[derive(Debug, Deserialize)]
struct ApiUser {
    name: String,
    username: String,
    links: ApiUserLinks,
}

#[derive(Debug, Deserialize)]
struct ApiUserLinks {
    html: String,
}

struct SelectedPhoto {
    photo: HomePhoto,
    download_location: String,
}

/// Clé Unsplash de l'application, compilée dans le binaire (voir `build.rs`).
///
/// Absente d'une compilation locale sans `UNSPLASH_ACCESS_KEY` : l'app garde
/// alors les photos embarquées.
fn builtin_key() -> Option<&'static str> {
    option_env!("DAYALI_UNSPLASH_ACCESS_KEY")
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

/// Enregistre dans le vault qu'une photo est affichée ce jour-là (sans effet hors vault ; un échec
/// d'écriture n'empêche jamais l'affichage de la photo).
fn remember(vault: Option<(&Path, &str)>, photo: &HomePhoto, logical_date: &str) {
    if let Some((root, machine_id)) = vault {
        let _ = home_photo_history::record(root, machine_id, &photo.id, logical_date);
    }
}

/// Photo du jour. `Ok(None)` sans clé : l'UI garde la photo embarquée.
///
/// `vault` = (racine, identifiant de machine) du vault ouvert : les identifiants déjà affichés y
/// sont lus (pour ne jamais les reproposer) et la photo choisie y est enregistrée.
pub async fn daily(
    data_dir: &Path,
    vault: Option<(&Path, &str)>,
    logical_date: &str,
    query: Option<&str>,
) -> Result<Option<HomePhoto>, DayaliError> {
    let Some(key) = builtin_key() else {
        return Ok(None);
    };
    validate_date(logical_date)?;

    let dir = data_dir.join("home-photos");
    std::fs::create_dir_all(&dir).map_err(|error| {
        DayaliError::from_io(&error, "préparation du cache de photo d'accueil")
    })?;
    let days_path = dir.join("days.json");
    let history_path = dir.join("history.json");

    let mut cache: DayCache = read_json(&days_path).unwrap_or_default();
    if let Some(photo) = cache.photos.get(logical_date) {
        remember(vault, photo, logical_date);
        return Ok(Some(photo.clone()));
    }

    let mut history: History = read_json(&history_path).unwrap_or_default();
    // Déjà affichées : historique du vault (toutes machines) + ancien historique local.
    let mut seen: Vec<String> = vault
        .map(|(root, _)| home_photo_history::seen_ids(root))
        .unwrap_or_default();
    for id in &history.ids {
        if !seen.contains(id) {
            seen.push(id.clone());
        }
    }
    let query = sanitize_query(query);
    let selected = fetch_unique(key, &query, &seen).await?;

    history.ids.retain(|id| id != &selected.photo.id);
    history.ids.push(selected.photo.id.clone());
    trim_history(&mut history.ids);

    cache
        .photos
        .insert(logical_date.to_string(), selected.photo.clone());
    trim_days(&mut cache.photos);

    write_json(&history_path, &history)?;
    write_json(&days_path, &cache)?;
    remember(vault, &selected.photo, logical_date);

    // Règle Unsplash : l'application « télécharge » la photo comme fond d'écran,
    // donc elle doit notifier `download_location` (au plus une fois par photo).
    trigger_download(key, &selected.download_location);

    Ok(Some(selected.photo))
}

fn validate_date(value: &str) -> Result<(), DayaliError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        DayaliError::schema_invalid("/logicalDate", "date logique attendue : AAAA-MM-JJ")
    })?;
    Ok(())
}

/// Mots-clés normalisés : espaces compactés, 120 caractères maximum, défaut
/// `landscape` (le mode Unsplash doit toujours renvoyer un paysage).
pub fn sanitize_query(query: Option<&str>) -> String {
    let raw = query.unwrap_or("").trim();
    if raw.is_empty() {
        return DEFAULT_QUERY.to_string();
    }
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(120).collect()
}

fn trim_history(ids: &mut Vec<String>) {
    if ids.len() > HISTORY_MAX {
        let extra = ids.len() - HISTORY_MAX;
        ids.drain(0..extra);
    }
}

fn trim_days(photos: &mut BTreeMap<String, HomePhoto>) {
    while photos.len() > DAYS_MAX {
        let Some(oldest) = photos.keys().next().cloned() else {
            break;
        };
        photos.remove(&oldest);
    }
}

/// URL d'image dimensionnée (hotlink exigé par Unsplash, aucune copie locale).
pub fn sized_url(raw: &str) -> String {
    let separator = if raw.contains('?') { '&' } else { '?' };
    format!("{raw}{separator}auto=format&fit=crop&w=2400&q=80")
}

fn attributed_url(raw: &str) -> String {
    let separator = if raw.contains('?') { '&' } else { '?' };
    format!("{raw}{separator}utm_source=dayali&utm_medium=referral")
}

fn client() -> Result<reqwest::Client, DayaliError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Dayali/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| network_error())
}

async fn fetch_unique(
    key: &str,
    query: &str,
    seen: &[String],
) -> Result<SelectedPhoto, DayaliError> {
    for _ in 0..ATTEMPTS {
        let photo = fetch_once(key, query).await?;
        if !seen.iter().any(|id| id == &photo.photo.id) {
            return Ok(photo);
        }
    }
    // Jamais de répétition : sans photo inédite, l'UI se rabat sur sa sélection locale.
    Err(DayaliError::new(
        ErrorCode::NotFound,
        "Aucune photo inédite n'a été trouvée pour ces mots-clés.",
    ))
}

async fn fetch_once(key: &str, query: &str) -> Result<SelectedPhoto, DayaliError> {
    let response = client()?
        .get(format!("{API_BASE}/photos/random"))
        .query(&[
            ("query", query),
            ("orientation", "landscape"),
            ("content_filter", "high"),
        ])
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .send()
        .await
        .map_err(|_| network_error())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(DayaliError::new(
            ErrorCode::Unauthorized,
            "Unsplash a refusé la clé de l'application. La photo embarquée est utilisée en attendant.",
        ));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(DayaliError::new(
            ErrorCode::RateLimited,
            "Quota Unsplash atteint. La photo embarquée est utilisée en attendant.",
        )
        .retryable());
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(DayaliError::new(
            ErrorCode::NotFound,
            "Aucune photo Unsplash ne correspond à ces mots-clés.",
        ));
    }
    if !status.is_success() {
        return Err(network_error());
    }

    let api: ApiPhoto = response.json().await.map_err(|_| network_error())?;
    Ok(parse_api_photo(api))
}

/// Transforme la réponse Unsplash en métadonnées de contrat (pure, testable).
fn parse_api_photo(api: ApiPhoto) -> SelectedPhoto {
    SelectedPhoto {
        photo: HomePhoto {
            id: api.id,
            src: sized_url(&api.urls.raw),
            credit: api.user.name,
            username: api.user.username,
            source: attributed_url(&api.user.links.html),
            license: "Unsplash License".to_string(),
            license_url: "https://unsplash.com/license".to_string(),
            title: api.alt_description.or(api.description),
        },
        download_location: api.links.download_location,
    }
}

fn trigger_download(key: &str, download_location: &str) {
    let key = key.to_string();
    let url = download_location.to_string();
    tauri::async_runtime::spawn(async move {
        if let Ok(client) = client() {
            let _ = client
                .get(&url)
                .query(&[("client_id", key.as_str())])
                .send()
                .await;
        }
    });
}

fn network_error() -> DayaliError {
    DayaliError::new(
        ErrorCode::Network,
        "Unsplash est injoignable. La photo embarquée est utilisée hors connexion.",
    )
    .retryable()
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DayaliError> {
    let tmp = tmp_path(path);
    let text = serde_json::to_vec_pretty(value).map_err(|error| {
        DayaliError::new(
            ErrorCode::Internal,
            format!("cache de photo d'accueil : {error}"),
        )
    })?;
    let mut file = std::fs::File::create(&tmp)
        .map_err(|error| DayaliError::from_io(&error, "écriture du cache de photo d'accueil"))?;
    file.write_all(&text)
        .map_err(|error| DayaliError::from_io(&error, "écriture du cache de photo d'accueil"))?;
    file.sync_all()
        .map_err(|error| DayaliError::from_io(&error, "écriture du cache de photo d'accueil"))?;
    std::fs::rename(&tmp, path)
        .map_err(|error| DayaliError::from_io(&error, "écriture du cache de photo d'accueil"))
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".tmp");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(id: &str) -> HomePhoto {
        HomePhoto {
            id: id.to_string(),
            src: "https://images.unsplash.com/photo-x".to_string(),
            credit: "Photographe".to_string(),
            username: "photographe".to_string(),
            source: "https://unsplash.com/@photographe".to_string(),
            license: "Unsplash License".to_string(),
            license_url: "https://unsplash.com/license".to_string(),
            title: None,
        }
    }

    #[test]
    fn query_defaults_to_landscape_and_is_bounded() {
        assert_eq!(sanitize_query(None), "landscape");
        assert_eq!(sanitize_query(Some("   ")), "landscape");
        assert_eq!(
            sanitize_query(Some("  mountain   lake  ")),
            "mountain lake"
        );
        assert_eq!(sanitize_query(Some(&"a".repeat(200))).chars().count(), 120);
    }

    #[test]
    fn history_keeps_only_the_most_recent_ids() {
        let mut ids: Vec<String> = (0..HISTORY_MAX + 10).map(|n| n.to_string()).collect();
        trim_history(&mut ids);
        assert_eq!(ids.len(), HISTORY_MAX);
        assert_eq!(ids.first().map(String::as_str), Some("10"));
    }

    #[test]
    fn day_cache_is_pruned_oldest_first() {
        let mut photos = BTreeMap::new();
        photos.insert("2026-01-01".to_string(), photo("a"));
        photos.insert("2026-01-02".to_string(), photo("b"));
        photos.insert("2026-01-03".to_string(), photo("c"));
        while photos.len() > 2 {
            let oldest = photos.keys().next().cloned().unwrap();
            photos.remove(&oldest);
        }
        assert!(!photos.contains_key("2026-01-01"));
        assert!(photos.contains_key("2026-01-03"));
    }

    #[test]
    fn urls_keep_existing_query_parameters() {
        assert_eq!(
            sized_url("https://images.unsplash.com/photo-a?ixid=1"),
            "https://images.unsplash.com/photo-a?ixid=1&auto=format&fit=crop&w=2400&q=80"
        );
        assert_eq!(
            attributed_url("https://unsplash.com/@a"),
            "https://unsplash.com/@a?utm_source=dayali&utm_medium=referral"
        );
    }

    #[test]
    fn dates_must_be_iso() {
        assert!(validate_date("2026-11-20").is_ok());
        assert!(validate_date("20/11/2026").is_err());
        assert!(validate_date("").is_err());
    }

    #[test]
    fn api_payload_maps_to_contract_metadata() {
        let api: ApiPhoto = serde_json::from_value(serde_json::json!({
            "id": "abc123",
            "alt_description": "A lake at dawn",
            "description": "ignored when alt exists",
            "urls": { "raw": "https://images.unsplash.com/photo-abc?ixid=1" },
            "links": {
                "download_location": "https://api.unsplash.com/photos/abc123/download?ixid=1"
            },
            "user": {
                "name": "Annie Spratt",
                "username": "anniespratt",
                "links": { "html": "https://unsplash.com/@anniespratt?ixid=1" }
            }
        }))
        .unwrap();

        let selected = parse_api_photo(api);
        assert_eq!(selected.photo.id, "abc123");
        assert_eq!(selected.photo.credit, "Annie Spratt");
        assert_eq!(
            selected.photo.src,
            "https://images.unsplash.com/photo-abc?ixid=1&auto=format&fit=crop&w=2400&q=80"
        );
        assert_eq!(
            selected.photo.source,
            "https://unsplash.com/@anniespratt?ixid=1&utm_source=dayali&utm_medium=referral"
        );
        assert_eq!(selected.photo.title.as_deref(), Some("A lake at dawn"));
        assert!(selected.download_location.ends_with("/download?ixid=1"));
    }
}

//! Abonnements aux calendriers iCal par URL (lecture seule).
//!
//! Stockage hors vault, dans les dossiers applicatifs de la machine :
//! - `config_dir/feeds.json` : abonnements (nom, URL, confidentialité, couleur) ;
//! - `cache_dir/feeds/<id>.ics` + `<id>.meta.json` : dernier flux valide + état de synchro.
//!
//! ATTENTION : l'URL d'un calendrier privé est un secret. Le coffre chiffré de la SPEC n'existant
//! pas encore, elle est ici stockée **en clair** sur cette machine (choix assumé, signalé à
//! l'utilisateur lors de l'ajout). Les messages d'erreur ne contiennent jamais l'URL.

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{DayaliError, ErrorCode};
use crate::models::calendar::{
    CalendarFeed, CalendarItem, FeedAddInput, FeedOccurrence, FeedSubscription,
    LocalCalendarEvent,
};
use crate::models::common::{iso_now, is_uuid, AppPaths, Precondition};
use crate::services::feed_ics::{self, Window, MAX_FEED_BYTES};
use crate::vault::{atomic, hash};

/// Nombre maximal de calendriers abonnés.
pub const MAX_FEEDS: usize = 20;

const FEEDS_FILE: &str = "feeds.json";

/// Sérialise les modifications de `feeds.json` (lecture-modification-écriture).
static FEEDS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedsFile {
    schema_version: u32,
    feeds: Vec<FeedSubscription>,
}

/// État de synchronisation d'un flux (métadonnées du cache).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FeedMeta {
    etag: Option<String>,
    last_modified: Option<String>,
    last_fetched_at: Option<String>,
    events_count: usize,
    error: Option<String>,
}

/// Écrit un fichier machine-local de façon atomique, en remplaçant l'existant (précondition = son
/// hash courant : jamais d'écrasement d'un fichier modifié entre-temps par un autre processus).
fn write_replacing(path: &Path, bytes: &[u8]) -> Result<(), DayaliError> {
    let precondition = hash::sha256_file(path)
        .ok()
        .map(|(current, _)| Precondition::hash(current));
    atomic::write_absolute_bytes(path, bytes, precondition.as_ref()).map(|_| ())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    FEEDS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------------------

fn load(config_dir: &Path) -> Result<Vec<FeedSubscription>, DayaliError> {
    let path = config_dir.join(FEEDS_FILE);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<FeedsFile>(&text)
            .map(|file| file.feeds)
            .map_err(|_| {
                DayaliError::schema_invalid(
                    "/",
                    "feeds.json : contenu non conforme (le fichier est conservé, non réécrit)",
                )
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(DayaliError::new(
            ErrorCode::Permission,
            "feeds.json est illisible",
        )),
    }
}

fn save(config_dir: &Path, feeds: &[FeedSubscription]) -> Result<(), DayaliError> {
    let file = FeedsFile {
        schema_version: 1,
        feeds: feeds.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|_| DayaliError::new(ErrorCode::Internal, "sérialisation de feeds.json impossible"))?;
    write_replacing(&config_dir.join(FEEDS_FILE), &bytes)
}

/// Normalise une adresse de calendrier : `webcal://` devient `https://`, seuls http(s) sont acceptés.
pub fn normalize_url(raw: &str) -> Result<String, DayaliError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(DayaliError::schema_invalid("/url", "adresse du calendrier requise"));
    }
    if trimmed.chars().count() > 2048 || trimmed.chars().any(char::is_whitespace) {
        return Err(DayaliError::schema_invalid(
            "/url",
            "adresse invalide (espaces ou longueur excessive)",
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    let candidate = if lower.starts_with("webcals://") {
        format!("https://{}", &trimmed["webcals://".len()..])
    } else if lower.starts_with("webcal://") {
        format!("https://{}", &trimmed["webcal://".len()..])
    } else {
        trimmed.to_string()
    };
    let url = reqwest::Url::parse(&candidate)
        .map_err(|_| DayaliError::schema_invalid("/url", "adresse invalide"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(DayaliError::schema_invalid(
            "/url",
            "l'adresse doit commencer par https:// (ou webcal://)",
        ));
    }
    Ok(url.to_string())
}

fn validate_input(input: &FeedAddInput) -> Result<(String, String, Option<String>), DayaliError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(DayaliError::schema_invalid(
            "/name",
            "le nom doit comporter entre 1 et 80 caractères",
        ));
    }
    let color = match input.color.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(color) => {
            let valid = color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit());
            if !valid {
                return Err(DayaliError::schema_invalid("/color", "couleur attendue : #RRGGBB"));
            }
            Some(color.to_ascii_lowercase())
        }
        None => None,
    };
    Ok((name.to_string(), normalize_url(&input.url)?, color))
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

fn cache_feeds_dir(cache_dir: &Path) -> std::path::PathBuf {
    cache_dir.join("feeds")
}

fn read_meta(dir: &Path, id: &str) -> FeedMeta {
    fs::read_to_string(dir.join(format!("{id}.meta.json")))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_meta(dir: &Path, id: &str, meta: &FeedMeta) {
    if let Ok(bytes) = serde_json::to_vec(meta) {
        let _ = write_replacing(&dir.join(format!("{id}.meta.json")), &bytes);
    }
}

fn remove_cache(cache_dir: &Path, id: &str) {
    let dir = cache_feeds_dir(cache_dir);
    let _ = fs::remove_file(dir.join(format!("{id}.ics")));
    let _ = fs::remove_file(dir.join(format!("{id}.meta.json")));
}

fn to_view(feed: &FeedSubscription, meta: &FeedMeta) -> CalendarFeed {
    CalendarFeed {
        id: feed.id.clone(),
        name: feed.name.clone(),
        url: feed.url.clone(),
        visibility: feed.visibility,
        color: feed.color.clone(),
        added_at: feed.added_at.clone(),
        last_fetched_at: meta.last_fetched_at.clone(),
        events_count: meta.events_count,
        error: meta.error.clone(),
    }
}

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, DayaliError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Dayali/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| DayaliError::new(ErrorCode::Network, "Le client réseau est indisponible."))
}

/// Message utilisateur pour une erreur réseau, **sans** détail pouvant contenir l'URL.
fn describe_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Le serveur met trop de temps à répondre.".to_string()
    } else if error.is_connect() {
        "Impossible de joindre le serveur du calendrier (vérifiez la connexion).".to_string()
    } else if error.is_redirect() {
        "Le serveur redirige trop de fois.".to_string()
    } else {
        "Erreur réseau pendant la récupération du calendrier.".to_string()
    }
}

enum Downloaded {
    NotModified,
    Fresh {
        text: String,
        etag: Option<String>,
        last_modified: Option<String>,
        events: usize,
    },
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    validators: Option<&FeedMeta>,
) -> Result<Downloaded, String> {
    use reqwest::header::{ACCEPT, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};

    let mut request = client
        .get(url)
        .header(ACCEPT, "text/calendar, text/plain;q=0.8, */*;q=0.5");
    if let Some(meta) = validators {
        if let Some(etag) = &meta.etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(modified) = &meta.last_modified {
            request = request.header(IF_MODIFIED_SINCE, modified);
        }
    }
    let mut response = request.send().await.map_err(|error| describe_network_error(&error))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED && validators.is_some() {
        return Ok(Downloaded::NotModified);
    }
    match status.as_u16() {
        200..=299 => {}
        401 | 403 => {
            return Err(
                "Accès refusé : le calendrier est protégé ou son adresse n'est plus valide."
                    .to_string(),
            )
        }
        404 | 410 => return Err("Adresse introuvable : le calendrier n'existe plus ou le lien est incorrect.".to_string()),
        429 => return Err("Le serveur limite les requêtes, réessayez plus tard.".to_string()),
        code => return Err(format!("Le serveur a répondu avec l'erreur {code}.")),
    }

    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let etag = header(ETAG);
    let last_modified = header(LAST_MODIFIED);

    let too_large = || "Le calendrier est trop volumineux (8 Mo maximum).".to_string();
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_FEED_BYTES)
    {
        return Err(too_large());
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| describe_network_error(&error))?
    {
        if bytes.len() + chunk.len() > MAX_FEED_BYTES {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let events = feed_ics::parse_calendar(&text).map_err(|_| {
        "Ce lien ne renvoie pas un calendrier iCal. Vérifiez l'adresse (flux .ics ou webcal)."
            .to_string()
    })?;
    Ok(Downloaded::Fresh {
        events: feed_ics::count_events(&events),
        text,
        etag,
        last_modified,
    })
}

/// Télécharge un flux et met à jour son cache. Ne renvoie jamais d'erreur : un échec est noté dans
/// `meta.error` et le dernier cache valide est **conservé**.
async fn fetch_into_cache(client: &reqwest::Client, cache_dir: &Path, feed: &FeedSubscription) -> FeedMeta {
    let dir = cache_feeds_dir(cache_dir);
    let _ = fs::create_dir_all(&dir);
    let ics_path = dir.join(format!("{}.ics", feed.id));
    let mut meta = read_meta(&dir, &feed.id);
    let have_cache = ics_path.is_file();
    let prior = meta.clone();

    match download(client, &feed.url, have_cache.then_some(&prior)).await {
        Ok(Downloaded::NotModified) => {
            meta.last_fetched_at = Some(iso_now());
            meta.error = None;
        }
        Ok(Downloaded::Fresh {
            text,
            etag,
            last_modified,
            events,
        }) => match write_replacing(&ics_path, text.as_bytes()) {
            Ok(_) => {
                meta.etag = etag;
                meta.last_modified = last_modified;
                meta.last_fetched_at = Some(iso_now());
                meta.events_count = events;
                meta.error = None;
            }
            Err(_) => {
                meta.error = Some("Impossible d'enregistrer le calendrier sur le disque.".to_string());
            }
        },
        Err(message) => meta.error = Some(message),
    }
    write_meta(&dir, &feed.id, &meta);
    meta
}

// ---------------------------------------------------------------------------
// API du service
// ---------------------------------------------------------------------------

pub fn list(paths: &AppPaths) -> Result<Vec<CalendarFeed>, DayaliError> {
    let dir = cache_feeds_dir(Path::new(&paths.cache_dir));
    Ok(load(Path::new(&paths.config_dir))?
        .iter()
        .map(|feed| to_view(feed, &read_meta(&dir, &feed.id)))
        .collect())
}

/// Ajoute un calendrier : il est téléchargé une première fois, et **n'est enregistré que s'il est
/// lisible** (une adresse fausse est signalée tout de suite plutôt qu'un abonnement muet).
pub async fn add(paths: &AppPaths, input: FeedAddInput) -> Result<CalendarFeed, DayaliError> {
    let (name, url, color) = validate_input(&input)?;
    let config_dir = Path::new(&paths.config_dir);
    let cache_dir = Path::new(&paths.cache_dir);

    {
        let _guard = lock();
        let existing = load(config_dir)?;
        if existing.len() >= MAX_FEEDS {
            return Err(DayaliError::schema_invalid(
                "/",
                format!("{MAX_FEEDS} calendriers au maximum"),
            ));
        }
        if existing.iter().any(|feed| feed.url == url) {
            return Err(DayaliError::schema_invalid(
                "/url",
                "ce calendrier est déjà ajouté",
            ));
        }
    }

    let feed = FeedSubscription {
        id: Uuid::now_v7().to_string(),
        name,
        url,
        visibility: input.visibility,
        color,
        added_at: iso_now(),
    };
    let meta = fetch_into_cache(&client()?, cache_dir, &feed).await;
    if let Some(message) = &meta.error {
        remove_cache(cache_dir, &feed.id);
        return Err(DayaliError::new(ErrorCode::Network, message.clone()).retryable());
    }

    let _guard = lock();
    let mut existing = load(config_dir)?;
    existing.push(feed.clone());
    save(config_dir, &existing)?;
    Ok(to_view(&feed, &meta))
}

pub fn remove(paths: &AppPaths, feed_id: &str) -> Result<(), DayaliError> {
    if !is_uuid(feed_id) {
        return Err(DayaliError::schema_invalid("/feedId", "identifiant de calendrier invalide"));
    }
    let _guard = lock();
    let config_dir = Path::new(&paths.config_dir);
    let mut feeds = load(config_dir)?;
    let before = feeds.len();
    feeds.retain(|feed| feed.id != feed_id);
    if feeds.len() == before {
        return Err(DayaliError::new(ErrorCode::NotFound, "calendrier introuvable"));
    }
    save(config_dir, &feeds)?;
    remove_cache(Path::new(&paths.cache_dir), feed_id);
    Ok(())
}

/// Actualise un calendrier (ou tous). Un échec garde le cache précédent et est noté dans l'état.
pub async fn refresh(paths: &AppPaths, only: Option<&str>) -> Result<Vec<CalendarFeed>, DayaliError> {
    let feeds = load(Path::new(&paths.config_dir))?;
    let client = client()?;
    for feed in feeds
        .iter()
        .filter(|feed| only.map_or(true, |id| id == feed.id))
    {
        fetch_into_cache(&client, Path::new(&paths.cache_dir), feed).await;
    }
    list(paths)
}

/// Occurrences des calendriers abonnés dans la fenêtre `from..=to` (dates `YYYY-MM-DD`), lues dans
/// le cache : aucun accès réseau, l'agenda reste utilisable hors connexion.
pub fn occurrences(
    paths: &AppPaths,
    from: &str,
    to: &str,
    display_tz: Tz,
) -> (Vec<FeedOccurrence>, Vec<String>) {
    let mut warnings = Vec::new();
    let parse = |value: &str| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok();
    let (Some(from), Some(to)) = (parse(from), parse(to)) else {
        return (Vec::new(), warnings);
    };
    let Some(window) = Window::new(from, to, display_tz) else {
        return (Vec::new(), warnings);
    };
    let feeds = match load(Path::new(&paths.config_dir)) {
        Ok(feeds) => feeds,
        Err(error) => {
            warnings.push(error.message);
            return (Vec::new(), warnings);
        }
    };
    let dir = cache_feeds_dir(Path::new(&paths.cache_dir));
    let mut out = Vec::new();
    for feed in feeds {
        let Ok(text) = fs::read_to_string(dir.join(format!("{}.ics", feed.id))) else {
            continue; // pas encore téléchargé
        };
        match feed_ics::parse_calendar(&text) {
            Ok(events) => {
                let mut feed_warnings = Vec::new();
                let mut occurrences =
                    feed_ics::expand(&events, &feed.id, display_tz, &window, &mut feed_warnings);
                for occurrence in &mut occurrences {
                    occurrence.calendar_name = Some(feed.name.clone());
                    occurrence.calendar_color = feed.color.clone();
                }
                out.extend(occurrences);
                warnings.extend(
                    feed_warnings
                        .into_iter()
                        .map(|message| format!("{} : {message}", feed.name)),
                );
            }
            Err(message) => warnings.push(format!("{} : {message}", feed.name)),
        }
    }
    (out, warnings)
}

/// Fusionne événements locaux et occurrences de flux, triés chronologiquement.
pub fn merge_items(
    local: Vec<LocalCalendarEvent>,
    feed: Vec<FeedOccurrence>,
    display_tz: Tz,
) -> Vec<CalendarItem> {
    let mut items: Vec<CalendarItem> = local
        .into_iter()
        .map(CalendarItem::Local)
        .chain(feed.into_iter().map(CalendarItem::Feed))
        .collect();
    items.sort_by_cached_key(|item| match item {
        CalendarItem::Local(event) => (feed_ics::sort_key(&event.start, display_tz), event.id.clone()),
        CalendarItem::Feed(occurrence) => (
            feed_ics::sort_key(&occurrence.start, display_tz),
            format!("{}:{}", occurrence.calendar_id, occurrence.uid),
        ),
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::calendar::FeedVisibility;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    const ICS: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1@test\r\nDTSTART:20261027T090000Z\r\nDTEND:20261027T100000Z\r\nSUMMARY:Rendez-vous\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn http(status: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut out = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        out
    }

    /// Mini serveur HTTP : une réponse prête par connexion, requêtes renvoyées dans le canal.
    fn serve(responses: Vec<String>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/prive/secret-token/basic.ics", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buffer = [0u8; 4096];
                let mut request = String::new();
                while !request.contains("\r\n\r\n") {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.push_str(&String::from_utf8_lossy(&buffer[..read]));
                }
                let _ = sender.send(request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (url, receiver)
    }

    fn dirs() -> (tempfile::TempDir, AppPaths) {
        let root = tempfile::tempdir().unwrap();
        let make = |name: &str| {
            let path = root.path().join(name);
            fs::create_dir_all(&path).unwrap();
            path.to_string_lossy().into_owned()
        };
        let paths = AppPaths {
            config_dir: make("config"),
            data_dir: make("data"),
            cache_dir: make("cache"),
            log_dir: make("log"),
        };
        (root, paths)
    }

    fn input(url: &str, visibility: FeedVisibility) -> FeedAddInput {
        FeedAddInput {
            name: "  Famille  ".to_string(),
            url: url.to_string(),
            visibility,
            color: Some("#E08A52".to_string()),
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn normalizes_urls_and_rejects_unsafe_schemes() {
        assert_eq!(
            normalize_url(" webcal://exemple.org/agenda.ics ").unwrap(),
            "https://exemple.org/agenda.ics"
        );
        assert_eq!(
            normalize_url("WEBCALS://exemple.org/a.ics").unwrap(),
            "https://exemple.org/a.ics"
        );
        assert!(normalize_url("https://exemple.org/a.ics").is_ok());
        for bad in ["", "   ", "file:///etc/passwd", "ftp://exemple.org/a.ics", "pas une url", "https://a b.org"] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validates_name_and_color() {
        let mut feed = input("https://exemple.org/a.ics", FeedVisibility::Public);
        assert_eq!(validate_input(&feed).unwrap().0, "Famille");
        assert_eq!(validate_input(&feed).unwrap().2.as_deref(), Some("#e08a52"));
        feed.color = Some("rouge".to_string());
        assert!(validate_input(&feed).is_err());
        feed.color = None;
        feed.name = "   ".to_string();
        assert!(validate_input(&feed).is_err());
    }

    #[test]
    fn add_stores_subscription_and_cache_and_lists_occurrences() {
        let (_root, paths) = dirs();
        let (url, _requests) = serve(vec![http("200 OK", &[("ETag", "\"v1\"")], ICS)]);
        let feed = block_on(add(&paths, input(&url, FeedVisibility::Private))).unwrap();
        assert_eq!(feed.name, "Famille");
        assert_eq!(feed.events_count, 1);
        assert!(feed.last_fetched_at.is_some() && feed.error.is_none());
        assert_eq!(feed.visibility, FeedVisibility::Private);

        assert_eq!(list(&paths).unwrap(), vec![feed.clone()]);

        let (items, warnings) = occurrences(&paths, "2026-10-27", "2026-10-27", chrono_tz::Europe::Paris);
        assert!(warnings.is_empty());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Rendez-vous");
        assert_eq!(items[0].calendar_id, feed.id);
        assert_eq!(items[0].calendar_name.as_deref(), Some("Famille"));
        assert_eq!(items[0].calendar_color.as_deref(), Some("#e08a52"));
        assert!(items[0].read_only);

        let (empty, _) = occurrences(&paths, "2026-11-10", "2026-11-12", chrono_tz::Europe::Paris);
        assert!(empty.is_empty());
    }

    #[test]
    fn add_refuses_a_link_that_is_not_a_calendar_and_subscribes_nothing() {
        let (_root, paths) = dirs();
        let (url, _requests) = serve(vec![http("200 OK", &[], "<html>Connexion requise</html>")]);
        let error = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap_err();
        assert_eq!(error.code, ErrorCode::Network);
        assert!(list(&paths).unwrap().is_empty());
        assert!(!error.message.contains("127.0.0.1") && !error.message.contains("secret-token"));
    }

    #[test]
    fn add_refuses_duplicates() {
        let (_root, paths) = dirs();
        let (url, _requests) = serve(vec![http("200 OK", &[], ICS)]);
        block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap();
        let error = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap_err();
        assert_eq!(error.code, ErrorCode::SchemaInvalid);
        assert_eq!(list(&paths).unwrap().len(), 1);
    }

    #[test]
    fn refresh_sends_validators_and_accepts_304() {
        let (_root, paths) = dirs();
        let (url, requests) = serve(vec![
            http("200 OK", &[("ETag", "\"v1\"")], ICS),
            http("304 Not Modified", &[], ""),
        ]);
        let feed = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap();
        requests.recv().unwrap();
        let feeds = block_on(refresh(&paths, Some(&feed.id))).unwrap();
        let second = requests.recv().unwrap().to_ascii_lowercase();
        assert!(second.contains("if-none-match: \"v1\""), "{second}");
        assert!(feeds[0].error.is_none());
        assert_eq!(feeds[0].events_count, 1);
    }

    #[test]
    fn failed_refresh_keeps_the_last_valid_cache_without_leaking_the_url() {
        let (_root, paths) = dirs();
        let (url, _requests) = serve(vec![
            http("200 OK", &[], ICS),
            http("404 Not Found", &[], "nope"),
            http("200 OK", &[], "pas un calendrier"),
        ]);
        let feed = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap();

        let after_404 = block_on(refresh(&paths, None)).unwrap();
        let message = after_404[0].error.clone().unwrap();
        assert!(!message.contains("127.0.0.1") && !message.contains("secret-token"));
        assert_eq!(after_404[0].events_count, 1);

        let after_garbage = block_on(refresh(&paths, Some(&feed.id))).unwrap();
        assert!(after_garbage[0].error.is_some());

        let (items, _) = occurrences(&paths, "2026-10-27", "2026-10-27", chrono_tz::UTC);
        assert_eq!(items.len(), 1, "le dernier cache valide reste affiché");
    }

    #[test]
    fn unreachable_server_is_reported_calmly() {
        let (_root, paths) = dirs();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x.ics", listener.local_addr().unwrap());
        drop(listener);
        let error = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap_err();
        assert_eq!(error.code, ErrorCode::Network);
        assert!(!error.message.contains("127.0.0.1"));
    }

    #[test]
    fn remove_deletes_subscription_and_cache() {
        let (_root, paths) = dirs();
        let (url, _requests) = serve(vec![http("200 OK", &[], ICS)]);
        let feed = block_on(add(&paths, input(&url, FeedVisibility::Public))).unwrap();
        let cache = cache_feeds_dir(Path::new(&paths.cache_dir));
        assert!(cache.join(format!("{}.ics", feed.id)).exists());

        remove(&paths, &feed.id).unwrap();
        assert!(list(&paths).unwrap().is_empty());
        assert!(!cache.join(format!("{}.ics", feed.id)).exists());
        assert_eq!(remove(&paths, &feed.id).unwrap_err().code, ErrorCode::NotFound);
        assert!(remove(&paths, "../../etc").is_err());
    }

    #[test]
    fn corrupt_feeds_file_is_reported_and_never_overwritten() {
        let (_root, paths) = dirs();
        let file = Path::new(&paths.config_dir).join(FEEDS_FILE);
        fs::write(&file, "{ pas du json").unwrap();
        assert!(list(&paths).is_err());
        let (items, warnings) = occurrences(&paths, "2026-10-27", "2026-10-27", chrono_tz::UTC);
        assert!(items.is_empty() && warnings.len() == 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "{ pas du json");
    }
}

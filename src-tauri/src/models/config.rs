//! `.dayali/config.json` — modèle persisté et invariants (PLAN §4.1).
//!
//! Source de vérité : `docs/schemas/config.schema.json`. Les champs et l'ordre
//! de sérialisation suivent le schéma ; `scripts/generate-contracts.mjs` vérifie
//! automatiquement la parité champ par champ (`--verify-models`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::DayaliError;
use crate::models::common::{is_project_id, is_sha256_hex, is_time_zone_name, is_uuid};

/// Version du format de `config.json`. Toute évolution incompatible s'accompagne
/// d'une migration dans `services/migrations.rs` ; un vault plus récent que
/// l'application est refusé explicitement, jamais réécrit.
pub const CONFIG_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub day_start_hour: u32,
    pub open_dashboard_on_launch: bool,
    pub locale: String,
    pub week_starts_on: u32,
    pub dashboard: Dashboard,
    pub views: Vec<View>,
    pub versioning: Versioning,
    pub sync: SyncSettings,
    pub limits: Limits,
    pub appearance: Appearance,
    pub quotes: Quotes,
    pub notifications: Notifications,
    pub end_of_day: EndOfDay,
}

/// Révision = SHA-256 du fichier lu, plus copie de conflit éventuelle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub config: Config,
    pub revision: String,
    pub conflict_copy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dashboard {
    pub columns: u32,
    pub row_height: u32,
    pub widgets: Vec<Widget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Widget {
    pub id: String,
    pub module: Module,
    pub view_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub layout: Layout,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Module {
    Agenda,
    Reminders,
    Journal,
    Projects,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub id: String,
    pub module: Module,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub origin: ViewOrigin,
    /// Filtre typé par module : validé à la lecture/écriture, conservé tel quel.
    pub filter: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<Sort>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewOrigin {
    User,
    Widget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sort {
    pub field: String,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Versioning {
    pub text: TextVersionPolicy,
    pub binaries: BinaryVersionPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextVersionPolicy {
    pub enabled: bool,
    pub retention: Retention,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BinaryVersionPolicy {
    pub enabled: bool,
    pub retention: Retention,
    pub max_file_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retention {
    pub mode: RetentionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_versions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age_days: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetentionMode {
    Count,
    Days,
    Forever,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSettings {
    pub hash_algorithm: String,
    pub check_on_vault_open: bool,
    pub check_on_file_open: bool,
    pub fallback_rescan_minutes: u32,
    pub transfer_stale_minutes: u32,
    pub transfer_history_limit: u32,
    pub version_on_close: bool,
    pub version_on_app_quit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub warn_vault_bytes: i64,
    pub min_free_bytes: i64,
    pub large_file_warn_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appearance {
    pub theme: Theme,
    pub accent_color: String,
    pub home_image: HomeImage,
    pub greeting: Greeting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Auto,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeImage {
    pub mode: HomeImageMode,
    pub unsplash_query: Option<String>,
    pub show_credit: bool,
    pub dim: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HomeImageMode {
    Bundled,
    Folder,
    Unsplash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Greeting {
    pub variants: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quotes {
    pub mode: QuotesMode,
    pub api: QuotesApi,
    pub refresh_hour: u32,
    pub include_custom: bool,
    pub pinned_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotesMode {
    ApiPreferred,
    BundledOnly,
    CustomOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotesApi {
    pub provider: QuotesProvider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotesProvider {
    None,
    Wikiquote,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notifications {
    pub late_night: LateNight,
    pub due_reminders: DueReminders,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LateNight {
    pub enabled: bool,
    pub after_hour: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DueReminders {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndOfDay {
    pub enabled: bool,
    pub propose_carry_over: bool,
}

impl Default for Config {
    /// Défauts exacts de `config.schema.json` (voir `docs/examples/config.json`
    /// pour une version avec vues et widgets). `widgets` et `views` sont vides :
    /// la vue « Ma journée » par défaut arrive à l'étape (b)/(c) (PLAN §4.5).
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            day_start_hour: 4,
            open_dashboard_on_launch: false,
            locale: "fr-FR".to_string(),
            week_starts_on: 1,
            dashboard: Dashboard {
                columns: 12,
                row_height: 40,
                widgets: Vec::new(),
            },
            views: Vec::new(),
            versioning: Versioning {
                text: TextVersionPolicy {
                    enabled: true,
                    retention: Retention {
                        mode: RetentionMode::Count,
                        max_versions: Some(50),
                        max_age_days: None,
                    },
                },
                binaries: BinaryVersionPolicy {
                    enabled: false,
                    retention: Retention {
                        mode: RetentionMode::Count,
                        max_versions: Some(5),
                        max_age_days: None,
                    },
                    max_file_bytes: Some(268_435_456),
                },
            },
            sync: SyncSettings {
                hash_algorithm: "sha256".to_string(),
                check_on_vault_open: true,
                check_on_file_open: true,
                fallback_rescan_minutes: 5,
                transfer_stale_minutes: 15,
                transfer_history_limit: 500,
                version_on_close: true,
                version_on_app_quit: true,
            },
            limits: Limits {
                warn_vault_bytes: 21_474_836_480,
                min_free_bytes: 2_147_483_648,
                large_file_warn_bytes: None,
            },
            appearance: Appearance {
                theme: Theme::Auto,
                accent_color: "#c2703d".to_string(),
                home_image: HomeImage {
                    mode: HomeImageMode::Bundled,
                    unsplash_query: None,
                    show_credit: true,
                    dim: 0.35,
                },
                greeting: Greeting { variants: true },
            },
            quotes: Quotes {
                mode: QuotesMode::BundledOnly,
                api: QuotesApi {
                    provider: QuotesProvider::None,
                },
                refresh_hour: 4,
                include_custom: true,
                pinned_ids: Vec::new(),
            },
            notifications: Notifications {
                late_night: LateNight {
                    enabled: true,
                    after_hour: 23,
                },
                due_reminders: DueReminders { enabled: false },
            },
            end_of_day: EndOfDay {
                enabled: true,
                propose_carry_over: true,
            },
        }
    }
}

impl Config {
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, DayaliError> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text.into_bytes())
    }

    /// Invariants non exprimables en JSON Schema (PLAN §4.1) et bornes des champs.
    pub fn validate(&self) -> Result<(), DayaliError> {
        if self.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(DayaliError::schema_invalid(
                "/schemaVersion",
                format!(
                    "schemaVersion {} inconnu : seul {} est supporté (aucune réécriture)",
                    self.schema_version, CONFIG_SCHEMA_VERSION
                ),
            ));
        }
        if self.day_start_hour > 23 {
            return Err(DayaliError::schema_invalid("/dayStartHour", "dayStartHour hors 0–23"));
        }
        if !is_locale(&self.locale) {
            return Err(DayaliError::schema_invalid("/locale", "locale attendue : fr-FR, en-US…"));
        }
        if !matches!(self.week_starts_on, 0 | 1 | 6) {
            return Err(DayaliError::schema_invalid(
                "/weekStartsOn",
                "weekStartsOn attendu : 0, 1 ou 6",
            ));
        }

        self.validate_dashboard()?;
        self.validate_views()?;
        self.validate_versioning()?;

        if self.sync.hash_algorithm != "sha256" {
            return Err(DayaliError::schema_invalid(
                "/sync/hashAlgorithm",
                "seul sha256 est admis en V1",
            ));
        }
        if !(1..=120).contains(&self.sync.fallback_rescan_minutes) {
            return Err(DayaliError::schema_invalid(
                "/sync/fallbackRescanMinutes",
                "fallbackRescanMinutes hors 1–120",
            ));
        }
        if !(1..=1440).contains(&self.sync.transfer_stale_minutes) {
            return Err(DayaliError::schema_invalid(
                "/sync/transferStaleMinutes",
                "transferStaleMinutes hors 1–1440",
            ));
        }
        if !(10..=10_000).contains(&self.sync.transfer_history_limit) {
            return Err(DayaliError::schema_invalid(
                "/sync/transferHistoryLimit",
                "transferHistoryLimit hors 10–10000",
            ));
        }

        if self.limits.warn_vault_bytes < 0 || self.limits.min_free_bytes < 0 {
            return Err(DayaliError::schema_invalid("/limits", "les seuils sont positifs ou nuls"));
        }
        if let Some(large) = self.limits.large_file_warn_bytes {
            if large < 0 {
                return Err(DayaliError::schema_invalid(
                    "/limits/largeFileWarnBytes",
                    "largeFileWarnBytes doit être null ou positif",
                ));
            }
        }

        self.validate_appearance()?;
        self.validate_quotes()?;

        if self.notifications.late_night.after_hour > 23 {
            return Err(DayaliError::schema_invalid(
                "/notifications/lateNight/afterHour",
                "afterHour hors 0–23",
            ));
        }

        Ok(())
    }

    fn validate_dashboard(&self) -> Result<(), DayaliError> {
        if self.dashboard.columns != 12 {
            return Err(DayaliError::schema_invalid(
                "/dashboard/columns",
                "la grille du dashboard a toujours 12 colonnes",
            ));
        }
        if !(24..=120).contains(&self.dashboard.row_height) {
            return Err(DayaliError::schema_invalid(
                "/dashboard/rowHeight",
                "rowHeight hors 24–120",
            ));
        }
        if self.dashboard.widgets.len() > 50 {
            return Err(DayaliError::schema_invalid(
                "/dashboard/widgets",
                "au plus 50 widgets",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for (index, widget) in self.dashboard.widgets.iter().enumerate() {
            let base = format!("/dashboard/widgets/{index}");
            if !is_uuid(&widget.id) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/id"),
                    "id de widget : UUID attendu",
                ));
            }
            if !seen.insert(widget.id.as_str()) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/id"),
                    "id de widget dupliqué",
                ));
            }
            if !is_uuid(&widget.view_id) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/viewId"),
                    "viewId : UUID attendu",
                ));
            }
            if !self.views.iter().any(|view| view.id == widget.view_id) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/viewId"),
                    "viewId orphelin : aucune vue enregistrée ne porte cet identifiant",
                ));
            }
            if let Some(title) = &widget.title {
                if title.is_empty() || title.chars().count() > 80 {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/title"),
                        "title attendu : 1 à 80 caractères",
                    ));
                }
            }
            let layout = widget.layout;
            let valid = layout.x <= 11
                && layout.y <= 1000
                && (2..=12).contains(&layout.w)
                && (2..=24).contains(&layout.h)
                && layout.x + layout.w <= 12;
            if !valid {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/layout"),
                    "invariant de grille violé : x + w <= 12, w dans 2–12, h dans 2–24",
                ));
            }
        }
        Ok(())
    }

    fn validate_views(&self) -> Result<(), DayaliError> {
        if self.views.len() > 200 {
            return Err(DayaliError::schema_invalid("/views", "au plus 200 vues"));
        }
        let mut seen = std::collections::HashSet::new();
        for (index, view) in self.views.iter().enumerate() {
            let base = format!("/views/{index}");
            if !is_uuid(&view.id) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/id"),
                    "id de vue : UUID attendu",
                ));
            }
            if !seen.insert(view.id.as_str()) {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/id"),
                    "id de vue dupliqué",
                ));
            }
            let name_len = view.name.chars().count();
            if name_len == 0 || name_len > 60 {
                return Err(DayaliError::schema_invalid(
                    &format!("{base}/name"),
                    "nom de vue : 1 à 60 caractères",
                ));
            }
            if let Some(icon) = &view.icon {
                if icon.chars().count() > 40 {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/icon"),
                        "icône : 40 caractères maximum",
                    ));
                }
            }
            for field in [&view.created_at, &view.updated_at] {
                crate::models::common::parse_iso(field)?;
            }
            validate_filter(view.module, &view.filter, &format!("{base}/filter"))?;
            if let Some(sort) = &view.sort {
                if sort.field.is_empty() || sort.field.chars().count() > 40 {
                    return Err(DayaliError::schema_invalid(
                        &format!("{base}/sort/field"),
                        "champ de tri : 1 à 40 caractères",
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_versioning(&self) -> Result<(), DayaliError> {
        validate_retention(&self.versioning.text.retention, "/versioning/text/retention")?;
        validate_retention(&self.versioning.binaries.retention, "/versioning/binaries/retention")?;
        if let Some(max_bytes) = self.versioning.binaries.max_file_bytes {
            if max_bytes < 0 {
                return Err(DayaliError::schema_invalid(
                    "/versioning/binaries/maxFileBytes",
                    "maxFileBytes doit être null ou positif",
                ));
            }
        }
        Ok(())
    }

    fn validate_appearance(&self) -> Result<(), DayaliError> {
        let color = &self.appearance.accent_color;
        let bytes = color.as_bytes();
        let valid_color = bytes.len() == 7
            && bytes[0] == b'#'
            && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit());
        if !valid_color {
            return Err(DayaliError::schema_invalid(
                "/appearance/accentColor",
                "couleur d'accent attendue : #RRGGBB",
            ));
        }
        let image = &self.appearance.home_image;
        if !image.show_credit {
            return Err(DayaliError::schema_invalid(
                "/appearance/homeImage/showCredit",
                "le crédit photographe est obligatoire",
            ));
        }
        if !(0.0..=0.85).contains(&image.dim) || image.dim.is_nan() {
            return Err(DayaliError::schema_invalid(
                "/appearance/homeImage/dim",
                "dim hors 0–0.85",
            ));
        }
        // `unsplashQuery` est indépendant du mode : vide ou null signifie
        // « landscape » (défaut du service), et une valeur conservée pendant un
        // passage en mode embarqué reste inoffensive. Aucun de ces cas ne doit
        // empêcher l'ouverture d'un vault.
        if let Some(query) = &image.unsplash_query {
            if query.chars().count() > 120 {
                return Err(DayaliError::schema_invalid(
                    "/appearance/homeImage/unsplashQuery",
                    "au plus 120 caractères",
                ));
            }
        }
        Ok(())
    }

    fn validate_quotes(&self) -> Result<(), DayaliError> {
        if self.quotes.refresh_hour > 23 {
            return Err(DayaliError::schema_invalid(
                "/quotes/refreshHour",
                "refreshHour hors 0–23",
            ));
        }
        if self.quotes.pinned_ids.len() > 100 {
            return Err(DayaliError::schema_invalid(
                "/quotes/pinnedIds",
                "au plus 100 citations épinglées",
            ));
        }
        for (index, id) in self.quotes.pinned_ids.iter().enumerate() {
            if !is_uuid(id) {
                return Err(DayaliError::schema_invalid(
                    &format!("/quotes/pinnedIds/{index}"),
                    "identifiant de citation : UUID attendu",
                ));
            }
        }
        let provider_must_be_none = matches!(self.quotes.mode, QuotesMode::BundledOnly | QuotesMode::CustomOnly);
        if provider_must_be_none && !matches!(self.quotes.api.provider, QuotesProvider::None) {
            return Err(DayaliError::schema_invalid(
                "/quotes/api/provider",
                "mode bundled-only/custom-only : api.provider doit valoir none",
            ));
        }
        Ok(())
    }
}

fn is_locale(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() == 2 {
        return bytes.iter().all(|byte| byte.is_ascii_lowercase());
    }
    bytes.len() == 5
        && bytes[0..2].iter().all(|byte| byte.is_ascii_lowercase())
        && bytes[2] == b'-'
        && bytes[3..5].iter().all(|byte| byte.is_ascii_uppercase())
}

fn validate_retention(retention: &Retention, path: &str) -> Result<(), DayaliError> {
    match retention.mode {
        RetentionMode::Count => {
            let Some(max_versions) = retention.max_versions else {
                return Err(DayaliError::schema_invalid(
                    path,
                    "mode count : maxVersions est requis",
                ));
            };
            if !(1..=1000).contains(&max_versions) {
                return Err(DayaliError::schema_invalid(
                    path,
                    "maxVersions hors 1–1000",
                ));
            }
        }
        RetentionMode::Days => {
            let Some(max_age_days) = retention.max_age_days else {
                return Err(DayaliError::schema_invalid(
                    path,
                    "mode days : maxAgeDays est requis",
                ));
            };
            if !(1..=3650).contains(&max_age_days) {
                return Err(DayaliError::schema_invalid(
                    path,
                    "maxAgeDays hors 1–3650",
                ));
            }
        }
        RetentionMode::Forever => {}
    }
    Ok(())
}

mod filters {
    // Les champs sont lus par la validation et par la sérialisation : certains ne
    // servent qu'à faire échouer un filtre inconnu (`deny_unknown_fields`).
    #![allow(dead_code)]

    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RemindersFilter {
        #[serde(default)]
        pub list_ids: Option<Vec<String>>,
        #[serde(default)]
        pub statuses: Option<Vec<String>>,
        #[serde(default)]
        pub due_within_days: Option<i64>,
        #[serde(default)]
        pub project_ids: Option<Vec<String>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AgendaFilter {
        #[serde(default)]
        pub range_days: Option<i64>,
        #[serde(default)]
        pub include_all_day: Option<bool>,
        #[serde(default)]
        pub project_ids: Option<Vec<String>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JournalFilter {
        #[serde(default)]
        pub range_days: Option<i64>,
        #[serde(default)]
        pub tags: Option<Vec<String>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ProjectsFilter {
        #[serde(default)]
        pub statuses: Option<Vec<String>>,
        #[serde(default)]
        pub tags: Option<Vec<String>>,
        #[serde(default)]
        pub has_open_todos: Option<bool>,
    }
}

fn validate_filter(module: Module, filter: &Value, path: &str) -> Result<(), DayaliError> {
    if !filter.is_object() {
        return Err(DayaliError::schema_invalid(path, "filter doit être un objet"));
    }
    match module {
        Module::Reminders => {
            let parsed: filters::RemindersFilter = serde_json::from_value(filter.clone())
                .map_err(|error| DayaliError::schema_invalid(path, format!("filter reminders invalide : {error}")))?;
            if let Some(list_ids) = &parsed.list_ids {
                if list_ids.len() > 50 {
                    return Err(DayaliError::schema_invalid(path, "listIds : 50 maximum"));
                }
                for id in list_ids {
                    if !is_uuid(id) {
                        return Err(DayaliError::schema_invalid(path, "listIds : UUID attendu"));
                    }
                }
            }
            if let Some(statuses) = &parsed.statuses {
                if statuses.len() > 3 {
                    return Err(DayaliError::schema_invalid(path, "statuses : 3 valeurs maximum"));
                }
                for status in statuses {
                    if !matches!(status.as_str(), "open" | "done" | "cancelled") {
                        return Err(DayaliError::schema_invalid(
                            path,
                            "statuses : open, done ou cancelled",
                        ));
                    }
                }
            }
            if let Some(days) = parsed.due_within_days {
                if !(0..=365).contains(&days) {
                    return Err(DayaliError::schema_invalid(path, "dueWithinDays hors 0–365"));
                }
            }
            validate_project_ids(parsed.project_ids.as_deref(), path)?;
        }
        Module::Agenda => {
            let parsed: filters::AgendaFilter = serde_json::from_value(filter.clone())
                .map_err(|error| DayaliError::schema_invalid(path, format!("filter agenda invalide : {error}")))?;
            if let Some(days) = parsed.range_days {
                if !(1..=62).contains(&days) {
                    return Err(DayaliError::schema_invalid(path, "rangeDays hors 1–62"));
                }
            }
            validate_project_ids(parsed.project_ids.as_deref(), path)?;
        }
        Module::Journal => {
            let parsed: filters::JournalFilter = serde_json::from_value(filter.clone())
                .map_err(|error| DayaliError::schema_invalid(path, format!("filter journal invalide : {error}")))?;
            if let Some(days) = parsed.range_days {
                if !(1..=365).contains(&days) {
                    return Err(DayaliError::schema_invalid(path, "rangeDays hors 1–365"));
                }
            }
            if let Some(tags) = &parsed.tags {
                if tags.len() > 20 {
                    return Err(DayaliError::schema_invalid(path, "tags : 20 maximum"));
                }
                for tag in tags {
                    let len = tag.chars().count();
                    if len == 0 || len > 40 {
                        return Err(DayaliError::schema_invalid(path, "tag : 1 à 40 caractères"));
                    }
                }
            }
        }
        Module::Projects => {
            let parsed: filters::ProjectsFilter = serde_json::from_value(filter.clone())
                .map_err(|error| DayaliError::schema_invalid(path, format!("filter projects invalide : {error}")))?;
            if let Some(statuses) = &parsed.statuses {
                if statuses.len() > 4 {
                    return Err(DayaliError::schema_invalid(path, "statuses : 4 valeurs maximum"));
                }
                for status in statuses {
                    if !matches!(status.as_str(), "active" | "paused" | "done" | "archived") {
                        return Err(DayaliError::schema_invalid(
                            path,
                            "statuses : active, paused, done ou archived",
                        ));
                    }
                }
            }
            if let Some(tags) = &parsed.tags {
                if tags.len() > 20 {
                    return Err(DayaliError::schema_invalid(path, "tags : 20 maximum"));
                }
                for tag in tags {
                    let len = tag.chars().count();
                    if len == 0 || len > 40 {
                        return Err(DayaliError::schema_invalid(path, "tag : 1 à 40 caractères"));
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_project_ids(project_ids: Option<&[String]>, path: &str) -> Result<(), DayaliError> {
    let Some(project_ids) = project_ids else {
        return Ok(());
    };
    if project_ids.len() > 50 {
        return Err(DayaliError::schema_invalid(path, "projectIds : 50 maximum"));
    }
    for project_id in project_ids {
        if !is_project_id(project_id) {
            return Err(DayaliError::schema_invalid(
                path,
                format!("projectId invalide : {project_id}"),
            ));
        }
    }
    Ok(())
}

/// Petit utilitaire pour les tests et les appelants : un filtre de fuseau n'est
/// pas stocké dans `config.json` (le fuseau vient de la machine).
pub fn is_supported_time_zone(value: &str) -> bool {
    is_time_zone_name(value)
}

/// Une révision est un SHA-256 hexadécimal minuscule.
pub fn is_revision(value: &str) -> bool {
    is_sha256_hex(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsplash_mode_accepts_a_missing_or_empty_query() {
        let mut config = Config::default();
        config.appearance.home_image.mode = HomeImageMode::Unsplash;

        config.appearance.home_image.unsplash_query = None;
        assert!(config.validate().is_ok());

        config.appearance.home_image.unsplash_query = Some("   ".to_string());
        assert!(config.validate().is_ok());

        config.appearance.home_image.unsplash_query = Some("a".repeat(121));
        assert!(config.validate().is_err());
    }

    #[test]
    fn a_saved_query_is_harmless_in_bundled_mode() {
        let mut config = Config::default();
        config.appearance.home_image.mode = HomeImageMode::Bundled;
        config.appearance.home_image.unsplash_query = Some("mountains".to_string());
        assert!(config.validate().is_ok());
    }
}

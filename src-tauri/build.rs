use std::path::Path;

/// Clé Unsplash lue dans l'environnement, sinon dans un `.env` local (ignoré par git).
fn unsplash_key() -> Option<String> {
    if let Ok(key) = std::env::var("UNSPLASH_ACCESS_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let env_file = Path::new("..").join(".env");
    println!("cargo:rerun-if-changed={}", env_file.display());
    let text = std::fs::read_to_string(env_file).ok()?;
    text.lines().find_map(|line| {
        let value = line.trim().strip_prefix("UNSPLASH_ACCESS_KEY=")?;
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn main() {
    // Clé Unsplash de l'application, partagée par toutes les installations. Elle
    // n'est jamais dans le dépôt (public) : secret GitHub Actions en release,
    // `.env` local en développement. Elle est compilée dans le binaire via
    // `rustc-env` ; l'utilisateur n'a jamais à la saisir.
    println!("cargo:rerun-if-env-changed=UNSPLASH_ACCESS_KEY");
    if let Some(key) = unsplash_key() {
        println!("cargo:rustc-env=DAYALI_UNSPLASH_ACCESS_KEY={key}");
    }
    tauri_build::build()
}

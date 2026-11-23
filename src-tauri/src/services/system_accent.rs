//! Couleur d'accent du système d'exploitation (lecture seule, sans dépendance).
//!
//! macOS : `AppleAccentColor` dans `NSGlobalDomain` donne l'index de la couleur
//! choisie dans Réglages Système ; `AppleHighlightColor` sert de repli pour les
//! accents personnalisés. Windows : `ColorizationColor` (DWM).
//!
//! Toute erreur (clé absente, plateforme inconnue) renvoie `None` : l'UI masque
//! alors l'option « suivre la couleur du système ».

/// Couleur d'accent du système en `#rrggbb`, si la plateforme l'expose.
pub fn read_accent_color() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        apple_accent_index()
            .and_then(accent_from_index)
            .map(str::to_string)
            .or_else(|| apple_highlight_color())
    }
    #[cfg(target_os = "windows")]
    {
        windows_accent_color()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Index `AppleAccentColor` → couleur d'accent (valeurs de Réglages Système).
///
/// `-1` graphite, `0` rouge, `1` orange, `2` jaune, `3` vert, `4` bleu
/// (défaut macOS), `5` mauve, `6` rose.
pub fn accent_from_index(index: i32) -> Option<&'static str> {
    match index {
        -1 => Some("#8e8e93"),
        0 => Some("#ff453a"),
        1 => Some("#ff9f0a"),
        2 => Some("#ffd60a"),
        3 => Some("#30d158"),
        4 => Some("#0a84ff"),
        5 => Some("#bf5af2"),
        6 => Some("#ff6482"),
        _ => None,
    }
}

/// `"0.968627 0.831373 1.000000 Purple"` → `"#f7d4ff"` (repli pour un accent
/// personnalisé, où `AppleAccentColor` n'est pas défini).
pub fn parse_highlight_color(raw: &str) -> Option<String> {
    let mut channels = raw.split_whitespace();
    let mut hex = String::from("#");
    for _ in 0..3 {
        let value = channels.next()?.parse::<f64>().ok()?;
        if !value.is_finite() {
            return None;
        }
        hex.push_str(&format!(
            "{:02x}",
            (value.clamp(0.0, 1.0) * 255.0).round() as u8
        ));
    }
    Some(hex)
}

#[cfg(target_os = "macos")]
fn apple_defaults(key: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn apple_accent_index() -> Option<i32> {
    apple_defaults("AppleAccentColor")?.parse().ok()
}

#[cfg(target_os = "macos")]
fn apple_highlight_color() -> Option<String> {
    parse_highlight_color(&apple_defaults("AppleHighlightColor")?)
}

#[cfg(target_os = "windows")]
fn windows_accent_color() -> Option<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\DWM",
            "/v",
            "ColorizationColor",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let token = text.split_whitespace().find(|part| part.starts_with("0x"))?;
    let value = u32::from_str_radix(&token[2..], 16).ok()?;
    Some(format!("#{:06x}", value & 0x00ff_ffff))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_macos_accent_palette() {
        assert_eq!(accent_from_index(4), Some("#0a84ff"));
        assert_eq!(accent_from_index(-1), Some("#8e8e93"));
        assert_eq!(accent_from_index(6), Some("#ff6482"));
        assert_eq!(accent_from_index(42), None);
    }

    #[test]
    fn parses_a_highlight_color_line() {
        assert_eq!(
            parse_highlight_color("0.968627 0.831373 1.000000 Purple").as_deref(),
            Some("#f7d4ff")
        );
        assert_eq!(parse_highlight_color("Multicolor"), None);
        assert_eq!(parse_highlight_color(""), None);
    }
}

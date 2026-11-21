# Publier une version et mettre à jour l'application

Dayali se met à jour depuis les **releases GitHub** du dépôt `la-tiags/Dayali`.

## Comment ça marche

1. Tu crées un tag `vX.Y.Z` : le workflow [`release.yml`](.github/workflows/release.yml) construit l'app
   (macOS universel, Windows, Linux), **signe** les paquets de mise à jour et crée une release **en brouillon**.
2. Le workflow y joint un fichier `latest.json` (versions, signatures, liens de téléchargement).
3. Tu **publies** le brouillon. À partir de là, `https://github.com/la-tiags/Dayali/releases/latest/download/latest.json`
   répond.
4. Les apps installées lisent ce fichier : 6 secondes après le lancement (en silence) ou depuis
   **Réglages → Mises à jour → Rechercher des mises à jour**. Si la version publiée est plus récente, une
   notification propose **Installer et redémarrer**. Rien n'est jamais installé sans clic.

La signature (clé minisign) garantit que l'app n'installe que des paquets produits avec **ta** clé :
la clé publique est dans `src-tauri/tauri.conf.json`, la clé privée ne quitte jamais ta machine ni les
secrets GitHub.

## Mise en place (une seule fois)

La paire de clés est créée avec :

```sh
pnpm tauri signer generate --ci -p "" -w ~/.tauri/dayali-updater.key
```

- `~/.tauri/dayali-updater.key` : **clé privée**, sans mot de passe. Ne la commite jamais.
  **Sauvegarde-la** (gestionnaire de mots de passe, coffre) : si elle est perdue, les apps déjà installées
  ne pourront plus se mettre à jour et il faudra les réinstaller à la main.
- `~/.tauri/dayali-updater.key.pub` : clé publique, déjà copiée dans `tauri.conf.json` (`plugins.updater.pubkey`).

Ajoute la clé privée aux secrets du dépôt :

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY -R la-tiags/Dayali < ~/.tauri/dayali-updater.key
```

Aucun secret de mot de passe n'est nécessaire (la clé n'en a pas). Si tu en ajoutes un un jour, crée aussi
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Publier une nouvelle version

```sh
pnpm release:bump 0.2.0        # met à jour package.json, tauri.conf.json, Cargo.toml et Cargo.lock
git commit -am "chore: version 0.2.0"
git push
git tag v0.2.0
git push origin v0.2.0         # déclenche le workflow
```

Quand les trois builds sont terminés, ouvre la release en brouillon sur GitHub, vérifie les fichiers,
rédige les notes de version puis clique sur **Publish release**.

Le workflow échoue tôt, avec un message explicite, si :

- le tag ne correspond pas à la version de l'app (`pnpm release:check v0.2.0` le vérifie en local) ;
- le secret `TAURI_SIGNING_PRIVATE_KEY` est absent.

## Clé Unsplash de l'application (photo d'accueil en ligne)

La clé Unsplash est **celle de l'application** : l'utilisateur n'en saisit jamais. Le dépôt étant public,
elle n'y figure pas ; elle est injectée uniquement au moment de la compilation par le workflow :

```sh
gh secret set UNSPLASH_ACCESS_KEY -R la-tiags/Dayali
# colle l'Access Key Unsplash (Client-ID) quand le prompt le demande
```

- Le secret est **obligatoire** : sans lui, le workflow échoue avant le build (comme pour la clé de
  signature), pour qu'aucune release ne parte sans photo Unsplash.
- La clé est compilée dans le binaire (`src-tauri/build.rs` → `cargo:rustc-env`) : elle n'apparaît ni dans le
  dépôt, ni dans les logs, ni dans l'UI. Elle reste toutefois extractible d'un binaire distribué par une
  personne motivée — c'est le compromis assumé du modèle sans serveur.
- Toute la flotte partage le quota de l'application (1 000 req/h en production : à demander à Unsplash
  quand l'app sera publique, le mode démo est limité à 50 req/h). À raison d'une requête par jour et par
  utilisateur, cela couvre un très grand nombre d'installations.
- En développement, mets `UNSPLASH_ACCESS_KEY=ta-clé` dans un fichier `.env` à la racine (ignoré par git)
  puis relance `pnpm tauri dev` ; sans clé, l'app garde simplement les photos embarquées.

## À savoir

- **Version identique = pas de mise à jour.** L'app compare sa version à celle de `latest.json` (semver).
- **Pré-releases ignorées.** L'URL `releases/latest` ne voit ni les brouillons ni les pré-releases : le
  workflow ne marque donc jamais une release comme pré-release, même pour une alpha ou une beta.
- **Pas de mise à jour en développement.** Dans `pnpm tauri dev` la vérification fonctionne mais
  l'installation est volontairement bloquée. Pour tester pour de vrai, installe un build de release.
- **Les notes affichées dans l'app** sont celles de la release au moment du build ; modifier le texte de la
  release après coup ne change pas `latest.json`.
- **macOS sans compte Apple Developer** : la première installation (depuis le `.dmg`) demande un clic droit →
  Ouvrir. Les mises à jour faites par l'app elle-même ne sont pas mises en quarantaine, mais comme la signature
  de code change à chaque build, macOS peut redemander l'accès à certains dossiers (Documents, kDrive…).
  La signature et la notarisation Apple (compte payant) suppriment ces demandes.
- **Rotation de la clé** : générer une nouvelle paire, remplacer `pubkey` et le secret. Les apps installées avec
  l'ancienne clé publique ne pourront pas installer ces versions : à n'envisager qu'en cas de fuite.

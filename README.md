<p align="center">
  <img src="public/favicon.svg" alt="Dayali" width="96" />
</p>

<h1 align="center">Dayali</h1>

<p align="center">
  <strong>Poste de pilotage personnel — local-first, formats ouverts, zéro serveur.</strong><br/>
  Cadrez votre journée le matin, faites le bilan le soir, gardez le contrôle tout au long.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0--alpha-blue" alt="version" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status" />
  <a href="https://github.com/la-tiags/Dayali/actions/workflows/verify.yml"><img src="https://github.com/la-tiags/Dayali/actions/workflows/verify.yml/badge.svg" alt="verify" /></a>
</p>

---

> **⚠️ Alpha publique** — L'application est fonctionnelle mais en développement actif. Des bugs sont attendus et l'API du vault peut encore changer.

---

## Qu'est-ce que Dayali ?

Dayali est une application de bureau **local-first** qui structure votre journée en trois temps :

| Moment | Ce que vous faites |
|---|---|
| 🌅 **Matin** | Démarrez la journée : consultez votre agenda, vos rappels, choisissez votre focus |
| 🗂 **Dashboard** | Travaillez avec vos widgets : calendrier, rappels, projets |
| 🌙 **Soir** | Faites le bilan : ce qui est fait, ce qui reste, ce qu'on reporte demain |

**Vos données vous appartiennent.** Tout est stocké en fichiers texte ouverts (Markdown, JSON, ICS) dans un dossier que vous choisissez — synchronisable par iCloud, Dropbox, Syncthing ou Git, selon votre préférence.

---

## Principes

- **Local-first** — Pas de compte, pas de serveur. Fonctionne hors ligne, à vie.
- **Formats ouverts** — Markdown, `.ics`, JSON. Dayali peut disparaître sans que vos données soient perdues.
- **Petits fichiers, zéro conflit** — Un fichier par rappel, par événement, un journal par machine.
- **Les secrets hors du vault** — Trousseau OS uniquement ; aucune donnée sensible dans les fichiers.
- **Multiplateforme** — macOS, Windows, Linux via [Tauri](https://tauri.app).

---

## Stack technique

| Couche | Technologie |
|---|---|
| UI | React 19 + TypeScript |
| Framework desktop | Tauri 2 (Rust) |
| Routage | React Router 8 |
| Validation | Zod 4 |
| État global | Zustand 5 |
| Bundler | Vite 8 |
| Tests | Vitest 5 + Testing Library + Playwright |
| Linter/Formatter | Biome 2 |

---

## Prérequis

- **Node.js** ≥ 22 (ou via `nvm` / `volta`)
- **pnpm** ≥ 12 (`npm install -g pnpm` ou `corepack enable`)
- **Rust** ≥ 1.90 ([rustup.rs](https://rustup.rs))
- **Tauri CLI** (installé automatiquement via `pnpm`)

Sur **macOS** : Xcode Command Line Tools requis (`xcode-select --install`).  
Sur **Linux** : `libwebkit2gtk-4.1`, `libappindicator3`, `librsvg2` (voir [tauri.app/start](https://tauri.app/start/prerequisites/)).

---

## Installation & développement

```bash
# Cloner le dépôt
git clone https://github.com/la-tiags/Dayali.git
cd Dayali

# Installer les dépendances JS
pnpm install

# Lancer en mode développement (front + backend Tauri)
pnpm tauri dev
```

### Commandes utiles

```bash
pnpm dev              # Vite seul (UI sans Tauri)
pnpm build            # Build de production (front uniquement)
pnpm tauri build      # Build Tauri complet (installeur natif)
pnpm test             # Tests unitaires Vitest
pnpm typecheck        # Vérification TypeScript
pnpm lint             # Linter Biome
pnpm verify           # Tout : lint, types, tests, build, Rust (= hook de commit et CI)
cd src-tauri && cargo test  # Tests Rust
```

---

## Mises à jour

L'application installée vérifie au démarrage s'il existe une release GitHub plus récente (**Réglages →
Mises à jour** pour le faire à la main) et propose de l'installer, avec des paquets signés.
Pour publier une version : voir [`RELEASING.md`](RELEASING.md).

## Structure du projet

```
dayali/
├── src/                  # Code TypeScript/React
│   ├── app/              # Routing, shell applicatif
│   ├── features/         # Écrans : today, dashboard, end-of-day, reminders…
│   ├── components/       # Composants réutilisables
│   └── lib/              # Utilitaires : time, reminders, ipc, schemas
├── src-tauri/            # Backend Rust (Tauri)
│   └── src/              # Commandes IPC, accès fichiers
├── tests/                # Tests d'audit et d'intégration
├── e2e/                  # Tests end-to-end Playwright
└── public/               # Assets statiques (icônes…)
```

---

## Structure du vault

Le **vault** est le dossier où Dayali stocke vos données. Vous le choisissez au premier lancement.

```
vault/
├── .dayali/
│   ├── config.json              # Préférences, disposition du dashboard
│   └── machines/<id>.json       # État propre à chaque installation
├── calendar/<uid>.ics           # Un fichier par événement
├── reminders/<id>.json          # Un fichier par rappel
├── journal/<YYYY-MM-DD>--<id>.md # Un journal par jour et par machine
└── quotes/custom.json           # Vos citations personnelles
```

---

## Contribuer

Le projet est en **alpha** et les contributions sont les bienvenues. Quelques points avant d'ouvrir une PR :

1. Les fichiers `docs/`, `SPEC.md` et `PROGRESS.md` sont exclus du dépôt (notes de conception privées).
2. Lancez `pnpm verify` avant tout commit (le hook git et la CI GitHub exécutent la même chaîne).
3. Respectez la structure de vault documentée ci-dessus — les changements de schéma doivent être validés.
4. Les photos d'accueil embarquées sont toutes sous licence CC0 1.0 (voir `src/assets/home/README.md`).

---

## Licence

MIT © Tiago — voir [LICENSE](./LICENSE) pour le texte complet.

---

<p align="center">
  <sub>Fait avec ☕ et beaucoup de matins calmes.</sub>
</p>

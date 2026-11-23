<p align="center">
  <img src="public/favicon.svg" alt="Dayali" width="96" />
</p>

<h1 align="center">Dayali</h1>

<p align="center">
  <strong>Poste de pilotage personnel — local-first, formats ouverts, zéro serveur.</strong><br/>
  Cadrez votre journée le matin, pilotez vos tâches et votre calendrier, faites le bilan le soir.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.2-blue" alt="version" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status" />
  <a href="https://github.com/la-tiags/Dayali/actions/workflows/verify.yml"><img src="https://github.com/la-tiags/Dayali/actions/workflows/verify.yml/badge.svg" alt="verify" /></a>
</p>

---

> **⚠️ Alpha publique** — L'application est pleinement fonctionnelle mais en développement actif.

---

## Qu'est-ce que Dayali ?

Dayali est une application de bureau **local-first** qui structure votre quotidien en respectant votre vie privée : aucun compte, aucun abonnement, aucun serveur distant. Vos données restent stockées dans un dossier (le **vault**) que vous choisissez et contrôlez.

L'application organise votre journée en trois temps forts :

| Moment | Ce que vous faites |
|---|---|
| 🌅 **Matin** | Accueil immersif : découvrez la photo du jour, une citation inspirante, faites le point sur vos événements et rappels, et planifiez les reports de la veille. |
| 🗂 **Dashboard & Agenda** | Pilotez votre journée avec un dashboard modulable (widgets redimensionnables et déplaçables) et un agenda complet inspiré d'Apple Calendar. |
| 🌙 **Soir** | Clôturez votre journée : dressez le bilan des tâches achevées, reportez ce qui doit l'être, et profitez d'une animation crépusculaire relaxante. |

---

## Fonctionnalités clés

### 🌅 Écran de début de journée
- **Accueil plein cadre** avec horloge, salutation dynamique, citation inspirante et photo haute résolution.
- **Rotation quotidienne des photos** : photos de paysages via Unsplash ou photos embarquées (CC0), avec mémorisation des identifiants dans le vault pour garantir une image différente chaque jour.
- **Aperçu du jour & report** : aperçu synthétique de l'agenda et des rappels, avec reprise en un clic des tâches non terminées de la veille.

### 🗂 Dashboard fluide & Widgets multi-listes
- **Drag-and-drop & réorganisation intuitive** : déplacez directement vos widgets à la souris sans contrainte de grille rigide. Les widgets adjacents se réorganisent automatiquement.
- **Redimensionnement responsive** : basculez chaque carte entre les tailles S, M et L en un clic.
- **Widgets Rappels multi-listes** : ajoutez des widgets dédiés à une liste précise (ex. *École*, *Travail*, *Personnel*) ou aux vues globales (*Toutes les tâches*, *Ma journée*). Changez la liste cible d'un widget à la volée en mode édition.
- **Widget Agenda** : vision instantanée de vos prochains rendez-vous de la journée.

### 📅 Agenda inspiré d'Apple Calendar
- **6 vues complètes** :
  - **Jour** : grille horaire (07:00 à 22:00) avec indicateur rouge en temps réel de l'heure actuelle et bandeau journée entière.
  - **3 jours** : colonne temporelle sur 3 jours glissants.
  - **Semaine** : vue 7 jours (Lundi – Dimanche) avec repères horaires.
  - **Mois** : calendrier mensuel complet avec pastille rouge dynamique pour le jour courant et navigation directe vers le jour sélectionné.
  - **Année** : vue d'ensemble des 12 mini-mois avec pastilles d'activité (*dots*) sur les jours ayant des événements.
  - **Liste** : liste épurée présentant **uniquement** les jours avec des événements (aucun jour vide superflu).
- **Standards ouverts** : persistance au format iCalendar standard (`.ics`, RFC 5545), gestion rigoureuse des fuseaux horaires IANA et des journées entières.

### 📋 Rappels & Listes personnalisées
- Système multi-listes avec couleurs personnalisées.
- Priorisation (« Ma journée » vs toutes les tâches), gestion des échéances, heures et fuseaux.
- Validation immédiate des tâches terminées depuis le dashboard ou l'écran dédié.

### 🌙 Bilan de fin de journée
- Synthèse visuelle des accomplissements du jour.
- Replanification facile des tâches restantes pour le lendemain.
- Animation crépusculaire et pluie d'étoiles filantes pour marquer la fin de la journée de travail.

---

## Principes de conception

- **Local-first** — Pas de compte, pas de télémétrie, pas de serveur. Fonctionne 100 % hors ligne.
- **Formats ouverts** — Markdown, `.ics`, JSON. Vous pouvez lire, éditer ou sauvegarder vos données avec n'importe quel autre outil.
- **Zéro conflit de synchronisation** — Un fichier par rappel, un fichier par événement, un journal par machine. Synchronisable via iCloud Drive, Syncthing, Dropbox, Google Drive ou Git.
- **Sécurité** — Les secrets et clés d'API ne sont jamais stockés dans le vault partagé.
- **Multiplateforme** — macOS, Windows, Linux propulsé par [Tauri 2](https://tauri.app).

---

## Stack technique

| Couche | Technologie |
|---|---|
| Interface utilisateur | React 19 + TypeScript |
| Framework desktop | Tauri 2 (Rust) |
| Routage | React Router 8 |
| Validation & Schémas | Zod 4 |
| Gestion d'état | Zustand 5 |
| Bundler & Outillage | Vite 8 + Biome 2 |
| Tests | Vitest 5 + Testing Library + Cargo Test (Rust) |

---

## Prérequis

- **Node.js** ≥ 22
- **pnpm** ≥ 12 (`corepack enable` ou `npm install -g pnpm`)
- **Rust** ≥ 1.90 ([rustup.rs](https://rustup.rs))

Sur **macOS** : Xcode Command Line Tools (`xcode-select --install`).  
Sur **Linux** : `libwebkit2gtk-4.1`, `libappindicator3`, `librsvg2` (voir [tauri.app/start](https://tauri.app/start/prerequisites/)).

---

## Installation & Développement

```bash
# Cloner le dépôt
git clone https://github.com/la-tiags/Dayali.git
cd Dayali

# Installer les dépendances
pnpm install

# Lancer en mode développement (Tauri + Vite)
pnpm tauri dev
```

### Commandes utiles

```bash
pnpm dev              # Interface web seule (dans le navigateur)
pnpm build            # Compilation frontend de production
pnpm tauri build      # Création du binaire et de l'installeur natif (.app, .dmg, etc.)
pnpm test             # Tests unitaires et d'intégration TypeScript (Vitest)
pnpm typecheck        # Vérification des types TypeScript
pnpm lint             # Linter & formateur Biome
pnpm verify           # Suite complète : lint, typecheck, tests JS, build, cargo check & test
cd src-tauri && cargo test  # Tests unitaires Rust du vault et des commandes IPC
```

---

## Structure du vault

Le **vault** est le dossier racine contenant l'intégralité de vos données :

```
vault/
├── .dayali/
│   ├── config.json              # Préférences, widgets du dashboard et vues
│   └── machines/<machineId>.json # État local et historique des photos
├── calendar/
│   └── <eventId>.ics            # Un fichier iCalendar par événement
├── reminders/
│   ├── lists/<listId>.json      # Définition des listes de rappels
│   └── <reminderId>.json        # Un fichier JSON par rappel
├── journal/
│   └── <YYYY-MM-DD>--<id>.md    # Journal de bord quotidien en Markdown
└── quotes/
    └── custom.json              # Vos citations personnalisées
```

---

## Licence

Distribué sous licence MIT. Voir [`LICENSE`](./LICENSE) pour plus d'informations.

<p align="center">
  <sub>Fait avec ☕ et beaucoup de matins calmes.</sub>
</p>

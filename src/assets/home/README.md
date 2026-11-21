# Photos d'accueil

Photos **réelles** embarquées dans le bundle de l'application pour l'écran
d'accueil (SPEC §6). Chaque image est importée côté application afin que Vite
la copie dans `dist/assets/` : aucun appel réseau, aucun cache distant, aucune
URL distante par défaut.

## Crédit affiché

Le crédit est rendu par `TodayScreen` dans un paragraphe discret, en bas à
droite, sur un fond sombre translucide (contraste ≥ 4.5:1). Format exact :

```text
Photo : <photographe> · CC0 1.0
```

Le titre (`title`) du paragraphe pointe vers la page Commons d'origine
(`source`) pour permettre la vérification. Aucun crédit n'est rendu si aucune
photo n'est fournie.

## Sélection de la photo du jour

`src/assets/home/photos.ts` expose `photoOfTheDay(seed)` :

- l'appelant passe `dayOfYear(now, timeZone)`, donc le jour **logique** local ;
- l'index vaut `seed % 4`, normalisé en `((seed % 4) + 4) % 4` pour rester
  valide avec un seed négatif ;
- la sélection est déterministe et cyclique : même jour logique = même photo,
  et la cinquième journée revient à la première photo ;
- l'ordre du tableau `homePhotos` est l'ordre de cycle documenté ci-dessous.

## Photos approuvées

Toutes les licences ont été **revérifiées via l'API Wikimedia Commons**
(`action=query&prop=imageinfo&iiprop=extmetadata`) le **8 novembre 2026**.
Valeurs brutes : `LicenseShortName=CC0`, `License=cc0`,
`LicenseUrl=http://creativecommons.org/publicdomain/zero/1.0/deed.en`
(la page canonique servie en HTTPS est
<https://creativecommons.org/publicdomain/zero/1.0/deed.en>).

### 1. `tuscan-sunrise.webp`

- **Fichier embarqué** : `src/assets/home/tuscan-sunrise.webp` — 2400 × 1600 px, 129894 octets (127 Kio)
- **Photographe** : Salvatore Gerace
- **Licence exacte** : CC0 1.0
- **Page source** : <https://commons.wikimedia.org/wiki/File:Tuscan_sunrise_-_Flickr_-_Salvatore_Gerace.jpg>
- **Page de licence** : <https://creativecommons.org/publicdomain/zero/1.0/deed.en>
- **Vérification** : 8 novembre 2026

### 2. `sunrise-fuji.webp`

- **Fichier embarqué** : `src/assets/home/sunrise-fuji.webp` — 2400 × 1985 px, 318058 octets (311 Kio)
- **Photographe** : Romain Guy
- **Licence exacte** : CC0 1.0
- **Page source** : <https://commons.wikimedia.org/wiki/File:Sunrise_with_Mount_Fuji_-_March_2025.jpg>
- **Page de licence** : <https://creativecommons.org/publicdomain/zero/1.0/deed.en>
- **Vérification** : 8 novembre 2026

### 3. `wilderness.webp`

- **Fichier embarqué** : `src/assets/home/wilderness.webp` — 2400 × 1594 px, 161720 octets (158 Kio)
- **Photographe** : David Marcu
- **Licence exacte** : CC0 1.0
- **Page source** : <https://commons.wikimedia.org/wiki/File:Alone_in_the_unspoilt_wilderness_(Unsplash).jpg>
- **Page de licence** : <https://creativecommons.org/publicdomain/zero/1.0/deed.en>
- **Vérification** : 8 novembre 2026

### 4. `scuol-motta-naluns.webp`

- **Fichier embarqué** : `src/assets/home/scuol-motta-naluns.webp` — 2400 × 1854 px, 69432 octets (68 Kio)
- **Photographe** : Agnes Monkelbaan
- **Licence exacte** : CC0 1.0
- **Page source** : <https://commons.wikimedia.org/wiki/File:Scuol-Motta_Naluns,_15-09-2023._(actm.)_09.jpg>
- **Page de licence** : <https://creativecommons.org/publicdomain/zero/1.0/deed.en>
- **Vérification** : 8 novembre 2026

## Mode en ligne optionnel (Unsplash)

Désactivé par défaut, réglable dans les Réglages. La clé Unsplash est celle de
l'application : compilée dans le binaire depuis un secret CI
(`src-tauri/build.rs`), jamais dans le dépôt, et l'utilisateur n'a rien à
saisir ni à choisir. Fournisseur unique pour l'instant (Unsplash).

- L'image Unsplash est **hotlinkée** (`images.unsplash.com`, aucun octet copié
  localement) ; seules les métadonnées (id, URL, crédit) sont mémorisées.
- L'historique d'ids empêche de revoir la même photo ; la photo reste stable
  pendant toute la journée logique.
- L'appel `download_location` est déclenché une fois par photo retenue, et les
  liens photographe/Unsplash portent `utm_source=dayali&utm_medium=referral`.
- Hors ligne, sans clé, en cas de quota ou d'échec réseau, les quatre photos
  CC0 ci-dessus reprennent automatiquement.

## Règles

- Ne jamais référencer une URL distante par défaut et ne jamais afficher un
  crédit pour une image absente.
- Le crédit doit reprendre le photographe et la licence exacts.
- Toute nouvelle photo doit être documentée ici (fichier, photographe,
  licence, source, licence, date de vérification, dimensions, poids) et
  proposée à Tiago, jamais décidée seule par l'implémentation.
- `src/assets/home/photos.test.ts` verrouille le nombre de photos, l'unicité
  des fichiers, les crédits, la licence et le caractère cyclique de la
  sélection.

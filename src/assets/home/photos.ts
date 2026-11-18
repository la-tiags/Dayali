import scuolMottaNaluns from "./scuol-motta-naluns.webp";
import sunriseFuji from "./sunrise-fuji.webp";
import tuscanSunrise from "./tuscan-sunrise.webp";
import wilderness from "./wilderness.webp";

/**
 * Photo d'accueil embarquée. Le crédit et la licence sont affichés tels quels
 * (SPEC §6) : aucun appel réseau, aucune image distante par défaut.
 */
export interface HomePhoto {
  /** URL produite par Vite pour le fichier embarqué. */
  readonly src: string;
  /** Nom exact du photographe, tel qu'affiché à l'écran. */
  readonly credit: string;
  /** Nom exact de la licence. */
  readonly license: string;
  /** Page Commons d'origine, conservée pour vérification. */
  readonly source: string;
  /** Texte de la licence (deed CC0). */
  readonly licenseUrl: string;
}

/**
 * Les quatre photos CC0 approuvées pour l'accueil. Toutes les licences ont été
 * revérifiées via l'API Wikimedia Commons le 8 novembre 2026 (voir README.md).
 */
const PHOTOS = [
  {
    src: tuscanSunrise,
    credit: "Salvatore Gerace",
    license: "CC0 1.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Tuscan_sunrise_-_Flickr_-_Salvatore_Gerace.jpg",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
  },
  {
    src: sunriseFuji,
    credit: "Romain Guy",
    license: "CC0 1.0",
    source: "https://commons.wikimedia.org/wiki/File:Sunrise_with_Mount_Fuji_-_March_2025.jpg",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
  },
  {
    src: wilderness,
    credit: "David Marcu",
    license: "CC0 1.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Alone_in_the_unspoilt_wilderness_(Unsplash).jpg",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
  },
  {
    src: scuolMottaNaluns,
    credit: "Agnes Monkelbaan",
    license: "CC0 1.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Scuol-Motta_Naluns,_15-09-2023._(actm.)_09.jpg",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
  },
] as const satisfies readonly HomePhoto[];

/** Liste ordonnée utilisée pour la sélection cyclique (jamais vide). */
export const homePhotos: readonly HomePhoto[] = PHOTOS;

/**
 * Sélection déterministe de la photo du jour : `seed % 4`.
 * Le modulo est normalisé pour rester valide même avec un seed négatif.
 * L'appelant passe `dayOfYear(now, timeZone)` : même jour logique = même photo.
 */
export function photoOfTheDay(seed: number): HomePhoto {
  const count = PHOTOS.length;
  const index = ((seed % count) + count) % count;
  return PHOTOS[index] ?? PHOTOS[0];
}

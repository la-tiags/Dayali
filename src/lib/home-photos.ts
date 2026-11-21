/**
 * Photo d'accueil Unsplash côté UI.
 *
 * Résout la photo Unsplash du jour :
 * 1. Depuis le cache local pour la journée logique (stabilité absolue durant la journée).
 * 2. Via l'IPC Rust si une clé API Unsplash est configurée côté backend.
 * 3. À défaut de clé API (ou hors quota), via une collection soignée de paysages
 *    Unsplash haute résolution qui tournent chaque jour en enregistrant l'historique
 *    des IDs pour ne jamais répéter les photos récentes.
 * 4. Les photos Wikimedia embarquées restent disponibles en ultime secours si la machine
 *    n'a aucun accès réseau (l'image ne charge pas).
 */

import { getIpc } from "./ipc";
import type { HomePhoto, HomePhotoInput } from "./ipc/api";

const STORAGE_PREFIX = "dayali:home-photo:";
const HISTORY_STORAGE_KEY = "dayali:home-photo-history";
const KEEP_DAYS = 90;
const HISTORY_MAX = 25;

export const UNSPLASH_HOME = "https://unsplash.com/?utm_source=dayali&utm_medium=referral";

export type { HomePhoto };

/**
 * Collection soignée de photos haute résolution Unsplash au format paysage.
 * Chaque photo respecte les directives Unsplash : lien du photographe avec UTM et licence.
 */
export const CURATED_UNSPLASH_PHOTOS: readonly HomePhoto[] = [
  {
    id: "1506744038136-46273834b3fb",
    src: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=2400&q=80",
    credit: "Dan Freeman",
    username: "danfreemanphoto",
    source: "https://unsplash.com/@danfreemanphoto?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Vallée de Yosemite au crépuscule",
  },
  {
    id: "1470071459604-3b5ec3a7fe05",
    src: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2400&q=80",
    credit: "Sergey Pesterev",
    username: "sergeypesterev",
    source: "https://unsplash.com/@sergeypesterev?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Brume sur les sommets alpins",
  },
  {
    id: "1472214103451-9374bd1c798e",
    src: "https://images.unsplash.com/photo-1472214103451-9374bd1c798e?auto=format&fit=crop&w=2400&q=80",
    credit: "Kalvis Svalbe",
    username: "kalviss",
    source: "https://unsplash.com/@kalviss?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Collines verdoyantes au lever du jour",
  },
  {
    id: "1501785888041-af3ef285b470",
    src: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=2400&q=80",
    credit: "Luca Bravo",
    username: "lucabravo",
    source: "https://unsplash.com/@lucabravo?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Barque sur lac de montagne embrumé",
  },
  {
    id: "1469474968028-56623f02e42e",
    src: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=2400&q=80",
    credit: "David Marcu",
    username: "davidmarcu",
    source: "https://unsplash.com/@davidmarcu?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Vallée baignée par la lumière dorée",
  },
  {
    id: "1426604966848-d7adac402bff",
    src: "https://images.unsplash.com/photo-1426604966848-d7adac402bff?auto=format&fit=crop&w=2400&q=80",
    credit: "Kalen Emsley",
    username: "kalenemsley",
    source: "https://unsplash.com/@kalenemsley?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Montagnes rocheuses sous ciel dramatique",
  },
  {
    id: "1470240731273-7821a6eeb6bd",
    src: "https://images.unsplash.com/photo-1470240731273-7821a6eeb6bd?auto=format&fit=crop&w=2400&q=80",
    credit: "Bailey Zindel",
    username: "baileyzindel",
    source: "https://unsplash.com/@baileyzindel?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Reflet des cimes enneigées au matin",
  },
  {
    id: "1497436072909-60f360e1d4b1",
    src: "https://images.unsplash.com/photo-1497436072909-60f360e1d4b1?auto=format&fit=crop&w=2400&q=80",
    credit: "Johannes Plenio",
    username: "jplenio",
    source: "https://unsplash.com/@jplenio?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Chemin automnal sous la frondaison",
  },
  {
    id: "1507525428034-b723cf961d3e",
    src: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=2400&q=80",
    credit: "Sean Oulashin",
    username: "oulashin",
    source: "https://unsplash.com/@oulashin?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Rivage turquoise et sable chaud",
  },
  {
    id: "1519681393784-d120267933ba",
    src: "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=2400&q=80",
    credit: "Benjamin Davies",
    username: "bendavisual",
    source: "https://unsplash.com/@bendavisual?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Montagne sous ciel étoilé",
  },
  {
    id: "1464822759023-fed622ff2c3b",
    src: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=2400&q=80",
    credit: "Kaltenberger Markus",
    username: "markus",
    source: "https://unsplash.com/@markus?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Massif montagneux imposant",
  },
  {
    id: "1500534314209-a25ddb2bd429",
    src: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=2400&q=80",
    credit: "Fabian Møller",
    username: "fabianmoller",
    source: "https://unsplash.com/@fabianmoller?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Forêt de conifères dans le brouillard",
  },
  {
    id: "1439853949127-fa647821eba0",
    src: "https://images.unsplash.com/photo-1439853949127-fa647821eba0?auto=format&fit=crop&w=2400&q=80",
    credit: "Sime Basioli",
    username: "simebasioli",
    source: "https://unsplash.com/@simebasioli?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Lac alpin aux eaux émeraude",
  },
  {
    id: "1475921075678-b021822c6645",
    src: "https://images.unsplash.com/photo-1475921075678-b021822c6645?auto=format&fit=crop&w=2400&q=80",
    credit: "Matthew Smith",
    username: "whos_tat",
    source: "https://unsplash.com/@whos_tat?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Lever de soleil sur l'océan paisible",
  },
  {
    id: "1511497584788-87676104235f",
    src: "https://images.unsplash.com/photo-1511497584788-87676104235f?auto=format&fit=crop&w=2400&q=80",
    credit: "Sebastian Unrau",
    username: "sebastian_unrau",
    source: "https://unsplash.com/@sebastian_unrau?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Rayons de lumière à travers les arbres",
  },
  {
    id: "1473448912268-2022ce9509d8",
    src: "https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=2400&q=80",
    credit: "Luca Bravo",
    username: "lucabravo",
    source: "https://unsplash.com/@lucabravo?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Forêt sauvage et brumeuse",
  },
  {
    id: "1518495973542-4542c06a5843",
    src: "https://images.unsplash.com/photo-1518495973542-4542c06a5843?auto=format&fit=crop&w=2400&q=80",
    credit: "Robert Lukeman",
    username: "robertlukeman",
    source: "https://unsplash.com/@robertlukeman?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Chute d'eau magistrale au crépuscule",
  },
  {
    id: "1506905925346-21bda4d32df4",
    src: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=2400&q=80",
    credit: "Dan Meyers",
    username: "danmeyers",
    source: "https://unsplash.com/@danmeyers?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Aiguilles rocheuses fendant la brume",
  },
  {
    id: "1513836279014-a89f7a76ae86",
    src: "https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?auto=format&fit=crop&w=2400&q=80",
    credit: "Annie Spratt",
    username: "anniespratt",
    source: "https://unsplash.com/@anniespratt?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Arbres givrés en plein hiver",
  },
  {
    id: "1441974231531-c6227db76b6e",
    src: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=2400&q=80",
    credit: "Jay Mantri",
    username: "jaymantri",
    source: "https://unsplash.com/@jaymantri?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Percée lumineuse en forêt",
  },
  {
    id: "1433086966358-54859d0ed716",
    src: "https://images.unsplash.com/photo-1433086966358-54859d0ed716?auto=format&fit=crop&w=2400&q=80",
    credit: "Thomas Bormans",
    username: "thomasbormans",
    source: "https://unsplash.com/@thomasbormans?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Pont de pierre et cascade moussue",
  },
  {
    id: "1447752875215-b2761acb3c5d",
    src: "https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?auto=format&fit=crop&w=2400&q=80",
    credit: "Jeremy Bishop",
    username: "jeremybishop",
    source: "https://unsplash.com/@jeremybishop?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Ruisseau automnal et feuillage écarlate",
  },
  {
    id: "1470770841072-f978cf4d019e",
    src: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=2400&q=80",
    credit: "Luca Bravo",
    username: "lucabravo",
    source: "https://unsplash.com/@lucabravo?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Chalet isolé au bord de l'eau",
  },
  {
    id: "1465146344425-f00d5f5c8f07",
    src: "https://images.unsplash.com/photo-1465146344425-f00d5f5c8f07?auto=format&fit=crop&w=2400&q=80",
    credit: "Philippe Wuyts",
    username: "philippewuyts",
    source: "https://unsplash.com/@philippewuyts?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Fleurs sauvages sur crête alpine",
  },
  {
    id: "1502082553048-f009c37129b9",
    src: "https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=2400&q=80",
    credit: "Dawid Zawiła",
    username: "dawidzawila",
    source: "https://unsplash.com/@dawidzawila?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Lumière matinale sur les vallons verts",
  },
  {
    id: "1518173946687-a4c8a383392e",
    src: "https://images.unsplash.com/photo-1518173946687-a4c8a383392e?auto=format&fit=crop&w=2400&q=80",
    credit: "Mark Harpur",
    username: "harpers",
    source: "https://unsplash.com/@harpers?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Miroir d'eau pure au cœur des montagnes",
  },
  {
    id: "1509316975850-ff9c5deb0cd9",
    src: "https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=2400&q=80",
    credit: "Pine Watt",
    username: "pinewatt",
    source: "https://unsplash.com/@pinewatt?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Dégradé de crêtes bleutées au levant",
  },
  {
    id: "1476514525535-07fb3b4ae5f1",
    src: "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?auto=format&fit=crop&w=2400&q=80",
    credit: "Clay Banks",
    username: "claybanks",
    source: "https://unsplash.com/@claybanks?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Navigation dans les fjords majestueux",
  },
  {
    id: "1542224566-6e85f2e6772f",
    src: "https://images.unsplash.com/photo-1542224566-6e85f2e6772f?auto=format&fit=crop&w=2400&q=80",
    credit: "Eberhard Grossgasteiger",
    username: "eberhardgross",
    source: "https://unsplash.com/@eberhardgross?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Aiguilles des Dolomites dans l'ombre du soir",
  },
  {
    id: "1504567961542-e24d9439a724",
    src: "https://images.unsplash.com/photo-1504567961542-e24d9439a724?auto=format&fit=crop&w=2400&q=80",
    credit: "Joshua Earle",
    username: "joshuaearle",
    source: "https://unsplash.com/@joshuaearle?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Randonnée sur la ligne de crête",
  },
  {
    id: "1491555103944-7c647fd857e6",
    src: "https://images.unsplash.com/photo-1491555103944-7c647fd857e6?auto=format&fit=crop&w=2400&q=80",
    credit: "Kalen Emsley",
    username: "kalenemsley",
    source: "https://unsplash.com/@kalenemsley?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Rivière émeraude au fond des gorges",
  },
  {
    id: "1513635269975-59663e0ac1ad",
    src: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=2400&q=80",
    credit: "Luke Chesser",
    username: "lukechesser",
    source: "https://unsplash.com/@lukechesser?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Col de montagne sous la lumière dorée",
  },
  {
    id: "1506953823976-52e1fdc0149a",
    src: "https://images.unsplash.com/photo-1506953823976-52e1fdc0149a?auto=format&fit=crop&w=2400&q=80",
    credit: "Derek Thomson",
    username: "derekthomson",
    source: "https://unsplash.com/@derekthomson?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Crique sauvage bordée d'eaux cristallines",
  },
  {
    id: "1470115636492-6d2b56f9146d",
    src: "https://images.unsplash.com/photo-1470115636492-6d2b56f9146d?auto=format&fit=crop&w=2400&q=80",
    credit: "Ryan Hutton",
    username: "ryanhutton",
    source: "https://unsplash.com/@ryanhutton?utm_source=dayali&utm_medium=referral",
    license: "Unsplash License",
    licenseUrl: "https://unsplash.com/license",
    title: "Pâturages baignés de soleil couchant",
  },
];

export function cacheKey(logicalDate: string): string {
  return `${STORAGE_PREFIX}${logicalDate}`;
}

/** Photo Unsplash déjà résolue pour cette journée logique, si elle existe. */
export function readCachedHomePhoto(logicalDate: string): HomePhoto | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(cacheKey(logicalDate));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const photo = parsed as Partial<HomePhoto>;
    if (
      typeof photo.id !== "string" ||
      typeof photo.src !== "string" ||
      typeof photo.credit !== "string" ||
      typeof photo.source !== "string"
    ) {
      return null;
    }
    return {
      id: photo.id,
      src: photo.src,
      credit: photo.credit,
      username: typeof photo.username === "string" ? photo.username : "",
      source: photo.source,
      license: typeof photo.license === "string" ? photo.license : "Unsplash License",
      licenseUrl:
        typeof photo.licenseUrl === "string" ? photo.licenseUrl : "https://unsplash.com/license",
      ...(typeof photo.title === "string" ? { title: photo.title } : {}),
    };
  } catch {
    return null;
  }
}

export function writeCachedHomePhoto(logicalDate: string, photo: HomePhoto): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(cacheKey(logicalDate), JSON.stringify(photo));
    pruneCache(logicalDate);
  } catch {
    // Quota ou stockage privé : la photo reste affichée, simplement non mémorisée.
  }
}

export function clearCachedHomePhoto(logicalDate: string): void {
  try {
    window.localStorage?.removeItem(cacheKey(logicalDate));
  } catch {
    // Rien à faire.
  }
}

/** Historique des IDs de photos récemment affichées. */
export function readPhotoIdHistory(): string[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

export function recordPhotoIdHistory(id: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const history = readPhotoIdHistory().filter((item) => item !== id);
    history.push(id);
    if (history.length > HISTORY_MAX) {
      history.splice(0, history.length - HISTORY_MAX);
    }
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignoré si le stockage est saturé.
  }
}

/**
 * Choisit une photo parmi la collection Unsplash qui n'a pas été affichée récemment,
 * de manière déterministe par rapport à la date logique.
 */
export function pickCuratedPhoto(logicalDate: string): HomePhoto {
  const history = readPhotoIdHistory();
  let available = CURATED_UNSPLASH_PHOTOS.filter((photo) => !history.includes(photo.id));

  // Si l'historique a presque tout épuisé, on libère les photos les plus anciennes
  if (available.length < 5) {
    const recent = history.slice(-10);
    available = CURATED_UNSPLASH_PHOTOS.filter((photo) => !recent.includes(photo.id));
  }

  // Si tout est encore filtré (collection courte), on prend l'ensemble
  const candidates = available.length > 0 ? available : CURATED_UNSPLASH_PHOTOS;

  // Hachage simple de la date logique (ex: "2026-11-21")
  let hash = 0;
  for (let index = 0; index < logicalDate.length; index += 1) {
    hash = (hash << 5) - hash + logicalDate.charCodeAt(index);
    hash |= 0;
  }
  const index = Math.abs(hash) % candidates.length;
  const fallback = CURATED_UNSPLASH_PHOTOS[0] as HomePhoto;
  const selected: HomePhoto = candidates[index] ?? fallback;

  recordPhotoIdHistory(selected.id);
  writeCachedHomePhoto(logicalDate, selected);
  return selected;
}

/** Ne conserve que les journées les plus récentes (les clés sont des dates ISO). */
function pruneCache(current: string): void {
  if (!window.localStorage) return;
  const dates: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) dates.push(key.slice(STORAGE_PREFIX.length));
  }
  dates.sort();
  const keepFrom = dates.length - KEEP_DAYS;
  for (let index = 0; index < keepFrom; index += 1) {
    const date = dates[index];
    if (date && date !== current) window.localStorage.removeItem(cacheKey(date));
  }
}

const inflight = new Map<string, Promise<HomePhoto | null>>();

/**
 * Charge la photo du jour.
 * 1. Mémoire/cache local du jour d'abord.
 * 2. Si non trouvée, tente l'appel IPC Unsplash (en direct via clé Rust).
 * 3. En l'absence de clé ou d'erreur réseau, sélectionne une photo Unsplash qui tourne
 *    quotidiennement sans répéter les IDs récents.
 */
export async function loadDailyHomePhoto(input: HomePhotoInput): Promise<HomePhoto> {
  const cached = readCachedHomePhoto(input.logicalDate);
  if (cached) return cached;

  const key = `${input.logicalDate}|${input.query ?? ""}`;
  const pending = inflight.get(key);
  if (pending) {
    const result = await pending;
    if (result) return result;
    return pickCuratedPhoto(input.logicalDate);
  }

  const request = getIpc()
    .homePhotoUnsplash(input)
    .then((photo) => {
      if (photo) {
        writeCachedHomePhoto(input.logicalDate, photo);
        recordPhotoIdHistory(photo.id);
        return photo;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  const photo = await request;
  if (photo) return photo;

  return pickCuratedPhoto(input.logicalDate);
}

/**
 * Vérifie que l'URL hotlinkée est réellement affichable (important hors ligne :
 * les métadonnées peuvent être en cache alors que l'image ne l'est pas).
 */
export function preloadImage(src: string): Promise<boolean> {
  if (typeof Image === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
}

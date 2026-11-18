// GENERATED FILE — DO NOT EDIT.
// Source: docs/schemas/config.schema.json
// Source-SHA256: ba13cb53318bc4dd588c089aeaf420c869f640ef9b05b5e6cd35ca8cf615c2c0
// Generator: scripts/generate-contracts.mjs (json-schema-to-zod)
//
// Les raffinements if/then/else sont validés par Ajv et par les validateurs
// Rust ; ce module est le contrat structurel de la frontière IPC.

import { z } from "zod";

export const configSchema = z
  .object({
    schemaVersion: z
      .literal(1)
      .describe(
        "Version du format persisté. Incrémentée uniquement en cas de migration (voir docs/PLAN.md §4.0).",
      ),
    dayStartHour: z
      .number()
      .int()
      .gte(0)
      .lte(23)
      .describe("Heure locale de début de journée logique. Défaut 4 h (SPEC §4).")
      .default(4),
    openDashboardOnLaunch: z
      .boolean()
      .describe("Si true, l'app ouvre le dashboard au lieu de l'accueil (SPEC §4).")
      .default(false),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .describe("Locale d'affichage. La langue des données reste l'anglais (voir PLAN §2.1).")
      .default("fr-FR"),
    weekStartsOn: z
      .union([z.literal(0), z.literal(1), z.literal(6)])
      .describe("0=dimanche, 1=lundi, 6=samedi.")
      .default(1),
    dashboard: z
      .object({
        columns: z
          .literal(12)
          .describe("Grille à 12 colonnes. Invariant non exprimable en JSON Schema : x + w <= 12."),
        rowHeight: z.number().int().gte(24).lte(120).default(40),
        widgets: z
          .array(
            z
              .object({
                enabled: z.boolean().default(true),
                id: z
                  .string()
                  .regex(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                  )
                  .describe(
                    "UUID en minuscules. UUIDv7 recommandé (triable par date de création).",
                  ),
                layout: z
                  .object({
                    h: z.number().int().gte(2).lte(24),
                    w: z.number().int().gte(2).lte(12),
                    x: z.number().int().gte(0).lte(11),
                    y: z.number().int().gte(0).lte(1000),
                  })
                  .strict(),
                module: z
                  .enum(["agenda", "reminders", "journal", "projects"])
                  .describe("Modules V1. mails sera ajouté en V3 (migration de schemaVersion)."),
                title: z.string().max(80).optional(),
                viewId: z
                  .string()
                  .regex(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                  )
                  .describe(
                    "UUID en minuscules. UUIDv7 recommandé (triable par date de création).",
                  ),
              })
              .strict(),
          )
          .max(50),
      })
      .strict(),
    views: z
      .array(
        z
          .object({
            createdAt: z
              .string()
              .datetime({ offset: true })
              .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
              .describe(
                "Horodatage UTC, RFC 3339, suffixe Z obligatoire. Millisecondes optionnelles.",
              ),
            filter: z.record(z.string(), z.any()),
            icon: z.string().max(40).optional(),
            id: z
              .string()
              .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
              .describe("UUID en minuscules. UUIDv7 recommandé (triable par date de création)."),
            module: z
              .enum(["agenda", "reminders", "journal", "projects"])
              .describe("Modules V1. mails sera ajouté en V3 (migration de schemaVersion)."),
            name: z.string().min(1).max(60),
            origin: z
              .enum(["user", "widget"])
              .describe(
                "widget = vue créée implicitement par le choix d'une liste dans un widget (elle reste éditable et supprimable).",
              ),
            sort: z
              .object({ direction: z.enum(["asc", "desc"]), field: z.string().min(1).max(40) })
              .strict()
              .optional(),
            updatedAt: z
              .string()
              .datetime({ offset: true })
              .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
              .describe(
                "Horodatage UTC, RFC 3339, suffixe Z obligatoire. Millisecondes optionnelles.",
              ),
          })
          .strict(),
      )
      .max(200)
      .describe(
        "Vues enregistrées. Un widget référence toujours une vue par viewId (principe 5 du SPEC).",
      ),
    versioning: z
      .object({
        text: z
          .object({
            enabled: z.boolean().default(true),
            retention: z
              .object({
                maxAgeDays: z.number().int().gte(1).lte(3650).optional(),
                maxVersions: z.number().int().gte(1).lte(1000).optional(),
                mode: z.enum(["count", "days", "forever"]),
              })
              .strict(),
          })
          .strict(),
        binaries: z
          .object({
            enabled: z.boolean().default(false),
            maxFileBytes: z
              .union([
                z
                  .number()
                  .int()
                  .gte(0)
                  .describe(
                    "Au-delà de cette taille (256 Mio par défaut), le binaire n'est pas versionné. La copie de référence est toujours faite et synchronisée ; aucun blocage.",
                  ),
                z.null(),
              ])
              .describe(
                "Au-delà de cette taille (256 Mio par défaut), le binaire n'est pas versionné. La copie de référence est toujours faite et synchronisée ; aucun blocage.",
              )
              .default(268435456),
            retention: z
              .object({
                maxAgeDays: z.number().int().gte(1).lte(3650).optional(),
                maxVersions: z.number().int().gte(1).lte(1000).optional(),
                mode: z.enum(["count", "days", "forever"]),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    sync: z
      .object({
        hashAlgorithm: z.literal("sha256"),
        checkOnVaultOpen: z.boolean().default(true),
        checkOnFileOpen: z.boolean().default(true),
        fallbackRescanMinutes: z
          .number()
          .int()
          .gte(1)
          .lte(120)
          .describe(
            "Rescan périodique de secours (filet de sécurité) : les montages réseau et dossiers cloud n'émettent pas toujours d'événements FS fiables. N'écrit rien et ne bloque aucune copie.",
          )
          .default(5),
        transferStaleMinutes: z
          .number()
          .int()
          .gte(1)
          .lte(1440)
          .describe(
            "Délai après lequel un transfert in-progress est affiché « copie abandonnée ? ». Aucune action automatique : seul l'utilisateur marque abandoned. Décision validée le 27/10/2026.",
          )
          .default(15),
        transferHistoryLimit: z
          .number()
          .int()
          .gte(10)
          .lte(10000)
          .describe(
            "Nombre d'entrées de transfert conservées par machine ; les plus anciennes et complètes sont purgées.",
          )
          .default(500),
        versionOnClose: z.boolean().default(true),
        versionOnAppQuit: z.boolean().default(true),
      })
      .strict(),
    limits: z
      .object({
        warnVaultBytes: z
          .number()
          .int()
          .gte(0)
          .describe(
            "Seuil d'alerte « le vault devient énorme » (20 Gio par défaut). Informatif uniquement : aucune copie n'est bloquée.",
          )
          .default(21474836480),
        minFreeBytes: z
          .number()
          .int()
          .gte(0)
          .describe(
            "Sous ce seuil d'espace libre (2 Gio par défaut), l'UI avertit. Informatif uniquement : la copie demandée est tentée, jamais refusée à cause de ce seuil.",
          )
          .default(2147483648),
        largeFileWarnBytes: z
          .union([
            z
              .number()
              .int()
              .gte(0)
              .describe(
                "null = pas de seuil d'alerte. Une valeur = avertissement « fichier volumineux » au-delà ; la copie est toujours possible (aucun plafond bloquant).",
              ),
            z.null(),
          ])
          .describe(
            "null = pas de seuil d'alerte. Une valeur = avertissement « fichier volumineux » au-delà ; la copie est toujours possible (aucun plafond bloquant).",
          )
          .default(null),
      })
      .strict(),
    appearance: z
      .object({
        theme: z.enum(["auto", "light", "dark"]).default("auto"),
        accentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default("#c2703d"),
        homeImage: z
          .object({
            mode: z
              .enum(["bundled", "folder", "unsplash"])
              .describe(
                "Mode par défaut : bundled (photos embarquées sous Unsplash License, hors ligne, crédit visible, image de secours incluse). unsplash = mode en ligne optionnel : hotlink de l'API Unsplash, crédit + liens utm_* + download_location, clé utilisateur au trousseau, AUCUN cache persistant de l'image (interdit par les conditions d'usage, PLAN §4.12) ; en cas d'échec réseau, retour à l'image bundlée. folder (photos perso, V2) ne désigne ici que le mode : le dossier est un chemin local, stocké dans machines/<machineId>.json#localState.homeImageFolder, jamais dans ce fichier partagé. Ce schéma n'expose aucun champ de cache d'image.",
              )
              .default("bundled"),
            unsplashQuery: z.union([z.string().max(120), z.null()]).default(null),
            showCredit: z
              .literal(true)
              .describe("Crédit photographe obligatoire pour Unsplash (SPEC §6)."),
            dim: z
              .number()
              .gte(0)
              .lte(0.85)
              .describe("Voile sombre pour la lisibilité.")
              .default(0.35),
          })
          .strict(),
        greeting: z
          .object({
            variants: z
              .boolean()
              .describe("Active les variantes de salutation selon l'heure (SPEC §4).")
              .default(true),
          })
          .strict(),
      })
      .strict(),
    quotes: z
      .object({
        mode: z
          .enum(["api-preferred", "bundled-only", "custom-only"])
          .describe(
            "bundled-only (défaut) = liste locale embarquée de 365 citations FR, hors ligne, rotation jourDeLAnnee % N. api-preferred = liste locale + API optionnelle si api.provider != none. custom-only = uniquement les citations de quotes/custom.json. Décision du 28/10/2026 : la liste locale est toujours le secours, une panne réseau ne bloque jamais l'accueil.",
          )
          .default("bundled-only"),
        api: z
          .object({
            provider: z
              .enum(["none", "wikiquote"])
              .describe(
                "none (défaut) = aucune API de citations, aucune clé. wikiquote = API MediaWiki de fr.wikiquote.org : CC BY-SA 4.0, cache local autorisé, attribution et lien obligatoires, aucune clé API, aucun quota dur documenté. ZenQuotes (usage non commercial) et API Ninjas Free (ni cache ni usage commercial) sont retirés des options distribuées (PLAN §4.12).",
              )
              .default("none"),
          })
          .strict(),
        refreshHour: z.number().int().gte(0).lte(23).default(4),
        includeCustom: z.boolean().default(true),
        pinnedIds: z
          .array(
            z
              .string()
              .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
              .describe("UUID en minuscules. UUIDv7 recommandé (triable par date de création)."),
          )
          .max(100)
          .describe(
            "Citations perso épinglées. Épinglage disponible dès la V1 (décision du 27/10/2026).",
          ),
      })
      .strict(),
    notifications: z
      .object({
        lateNight: z
          .object({
            enabled: z.boolean().default(true),
            afterHour: z
              .number()
              .int()
              .gte(0)
              .lte(23)
              .describe(
                "Heure à partir de laquelle le message « il est tard » peut apparaître, une fois par nuit logique (état par machine).",
              )
              .default(23),
          })
          .strict(),
        dueReminders: z
          .object({
            enabled: z
              .boolean()
              .describe("Notifications OS pour rappels échus. Non requis en V1.")
              .default(false),
          })
          .strict(),
      })
      .strict(),
    endOfDay: z
      .object({ enabled: z.boolean().default(true), proposeCarryOver: z.boolean().default(true) })
      .strict(),
  })
  .strict()
  .describe(
    "Emplacement : .dayali/config.json. Fichier partagé entre machines (préférences + dashboard + vues). Écriture atomique, contrôle de révision par hash, copie de conflit en cas de divergence (voir docs/PLAN.md §4.1 et §4.11).",
  );

export type Config = z.infer<typeof configSchema>;

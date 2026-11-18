// GENERATED FILE — DO NOT EDIT.
// Source: docs/schemas/common.schema.json
// Source-SHA256: 600e57f3dbec5bf38018b52cee660831b2187becf90bde94280b38249e19752c
// Generator: scripts/generate-contracts.mjs (json-schema-to-zod)
//
// Les raffinements if/then/else sont validés par Ajv et par les validateurs
// Rust ; ce module est le contrat structurel de la frontière IPC.

import { z } from "zod";

export const schemaVersionSchema = z
  .literal(1)
  .describe(
    "Version du format persisté. Incrémentée uniquement en cas de migration (voir docs/PLAN.md §4.0).",
  );

export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .describe("UUID en minuscules. UUIDv7 recommandé (triable par date de création).");

export type Uuid = z.infer<typeof uuidSchema>;

export const machineIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .describe("UUID en minuscules. UUIDv7 recommandé (triable par date de création).");

export type MachineId = z.infer<typeof machineIdSchema>;

export const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
  .describe("Horodatage UTC, RFC 3339, suffixe Z obligatoire. Millisecondes optionnelles.");

export type Timestamp = z.infer<typeof timestampSchema>;

export const localDateSchema = z
  .string()
  .date()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Date civile locale (fuseau de la machine), sans heure.");

export type LocalDate = z.infer<typeof localDateSchema>;

export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Heure locale HH:mm, 24 h.");

export type LocalTime = z.infer<typeof localTimeSchema>;

export const timeZoneSchema = z
  .string()
  .regex(/^(UTC|[A-Z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/)
  .min(1)
  .max(64)
  .describe(
    "Identifiant IANA canonique (ex. Europe/Paris, America/New_York, America/Argentina/Buenos_Aires, UTC). Un identifiant sans région (CET, GMT) et les décalages numériques (GMT+1 hors Etc/) sont refusés. Le motif n'est qu'une validation syntaxique : l'appartenance à la base IANA est vérifiée en Rust (chrono-tz) ; un identifiant inconnu produit un avertissement visible, jamais un décalage silencieux (PLAN §2.3, §4.7.1).",
  );

export type TimeZone = z.infer<typeof timeZoneSchema>;

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Empreinte SHA-256 en hexadécimal minuscule. Seul algorithme admis en V1.");

export type Sha256 = z.infer<typeof sha256Schema>;

export const relativePathSchema = z
  .intersection(
    z.intersection(z.string().regex(/^[^\/\\]/), z.string().regex(/^(?![\s\S]*?(?:\\))/)),
    z.intersection(
      z.string().regex(/^(?![\s\S]*?(?:(^|\/)\.\.?(\/|$)))/),
      z.string().regex(/^(?![\s\S]*?(?:\/$))/),
    ),
  )
  .describe(
    "Chemin POSIX relatif à la racine du vault, normalisé NFC, séparateur /. Pas de chemin absolu, pas de \\, pas de segment . ou .., pas de / final.",
  );

export type RelativePath = z.infer<typeof relativePathSchema>;

export const absolutePathSchema = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\\/]|\\\\[^\\\/]+[\\\/])/)
  .min(1)
  .max(4096)
  .describe(
    "Chemin absolu local à une machine (hors vault) : POSIX (/...), Windows avec lettre de lecteur (C:\\... ou C:/...) ou UNC (\\\\serveur\\partage). Un chemin relatif, ~/... ou une URL est refusé. Jamais interprété sur une autre machine.",
  );

export type AbsolutePath = z.infer<typeof absolutePathSchema>;

export const projectIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{8}$/)
  .min(11)
  .max(58)
  .describe(
    "Identifiant immuable d'un projet : <slug>--<suffixe aléatoire 8 hex>. Le slug est en minuscules ASCII, sans `--` interne, sans `-` initial ni final, tronqué à 48 caractères sur une frontière de mot (le total est donc ≤ 58). Le slug est lisible mais purement décoratif ; le nom affiché est le champ name, librement modifiable. Le dossier projects/<projectId>/ ne change jamais de nom (voir PLAN §2.2 et §4.6).",
  );

export type ProjectId = z.infer<typeof projectIdSchema>;

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

export type Semver = z.infer<typeof semverSchema>;

export const moduleSchema = z
  .enum(["agenda", "reminders", "journal", "projects"])
  .describe("Modules V1. mails sera ajouté en V3 (migration de schemaVersion).");

export type Module = z.infer<typeof moduleSchema>;

export const syncStateSchema = z
  .enum(["synced", "in-progress", "awaiting-origin", "conflict"])
  .describe(
    "État dérivé, jamais saisi à la main. Mapping UI : synced=synchronisé, in-progress=en cours, awaiting-origin=en attente de la machine d'origine, conflict=conflit.",
  );

export type SyncState = z.infer<typeof syncStateSchema>;

export const transferStateSchema = z
  .enum(["in-progress", "complete", "abandoned"])
  .describe(
    "in-progress=en cours, complete=complet, abandoned=abandonné (marqué par l'utilisateur ; un état périmé se déduit de lastActivityAt).",
  );

export type TransferState = z.infer<typeof transferStateSchema>;

export const versionReasonSchema = z
  .enum(["close", "manual", "import", "conflict-branch", "restore"])
  .describe(
    "close=fermeture avec contenu modifié, manual=action explicite, import=première copie, conflict-branch=branche créée via « modifier quand même », restore=restauration.",
  );

export type VersionReason = z.infer<typeof versionReasonSchema>;

export const fileKindSchema = z.enum(["text", "binary"]);

export type FileKind = z.infer<typeof fileKindSchema>;

export const hashAlgorithmSchema = z.literal("sha256");

export type HashAlgorithm = z.infer<typeof hashAlgorithmSchema>;

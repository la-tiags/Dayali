// GENERATED FILE — DO NOT EDIT.
// Source: docs/schemas/machine-local.schema.json
// Source-SHA256: 80671aa9507855b2357b3c53d0e77eb9274a86a19722580e30c496017651ab13
// Generator: scripts/generate-contracts.mjs (json-schema-to-zod)
//
// Les raffinements if/then/else sont validés par Ajv et par les validateurs
// Rust ; ce module est le contrat structurel de la frontière IPC.

import { z } from "zod";

export const machineLocalSchema = z
  .object({
    schemaVersion: z
      .literal(1)
      .describe(
        "Version du format persisté. Incrémentée uniquement en cas de migration (voir docs/PLAN.md §4.0).",
      ),
    machineId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      .describe("UUID en minuscules. UUIDv7 recommandé (triable par date de création)."),
    createdAt: z
      .string()
      .datetime({ offset: true })
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
      .describe("Horodatage UTC, RFC 3339, suffixe Z obligatoire. Millisecondes optionnelles."),
    lastVaultPath: z
      .union([
        z
          .string()
          .regex(/^(\/|[A-Za-z]:[\\\/]|\\\\[^\\\/]+[\\\/])/)
          .min(1)
          .max(4096)
          .describe(
            "Chemin absolu local à une machine (hors vault) : POSIX (/...), Windows avec lettre de lecteur (C:\\... ou C:/...) ou UNC (\\\\serveur\\partage). Un chemin relatif, ~/... ou une URL est refusé. Jamais interprété sur une autre machine.",
          ),
        z.null(),
      ])
      .describe(
        "Chemin absolu local du dernier vault ouvert avec succès, null tant qu'aucun vault n'a été ouvert. Mis à jour atomiquement à chaque vault_open réussi ; ne figure ni dans config.json ni dans .dayali/machines/<machineId>.json. Exemples : macOS /Users/alice/Documents/Dayali ; Windows C:\\\\Users\\\\alice\\\\Documents\\\\Dayali ; Linux /home/alice/Dayali. Un chemin n'est jamais interprété sur une autre machine.",
      ),
    recentVaults: z
      .array(
        z
          .string()
          .regex(/^(\/|[A-Za-z]:[\\\/]|\\\\[^\\\/]+[\\\/])/)
          .min(1)
          .max(4096)
          .describe(
            "Chemin absolu local à une machine (hors vault) : POSIX (/...), Windows avec lettre de lecteur (C:\\... ou C:/...) ou UNC (\\\\serveur\\partage). Un chemin relatif, ~/... ou une URL est refusé. Jamais interprété sur une autre machine.",
          ),
      )
      .max(10)
      .describe(
        "Vaults récemment ouverts, du plus récent au plus ancien, chemins absolus locaux. Au plus 10 entrées ; une nouvelle ouverture place son chemin en tête et tronque la fin. L'application propose cette liste au lancement, sans ouvrir de vault automatiquement en cas d'échec du dernier chemin. Invariant Rust (non exprimable ici) : si lastVaultPath != null, il est égal à recentVaults[0].",
      ),
  })
  .strict()
  .describe(
    "Emplacement : machine.json hors du vault, dans le dossier de configuration de l'application (PLAN §4.10). Ce fichier n'est JAMAIS synchronisé avec le vault. Il porte l'identité autoritaire de l'installation et la mémoire du dernier vault ouvert. Le schéma s'appelle « machine-local » parce que « machine.schema.json » désigne déjà le fichier .dayali/machines/<machineId>.json du vault. Un seul vault est actif à la fois ; recentVaults sert uniquement à rouvrir un vault, jamais à en ouvrir plusieurs en parallèle.",
  );

export type MachineLocal = z.infer<typeof machineLocalSchema>;

/**
 * Destination d'atterrissage après l'ouverture d'un vault ou au lancement.
 *
 * Règle (SPEC §6, PLAN §6(a) critères 4–6) :
 * - aucun vault → écran de choix ;
 * - `openDashboardOnLaunch=true` → dashboard (l'accueil reste accessible
 *   à la demande via « revoir l'accueil ») ;
 * - journée déjà démarrée sur cette machine → dashboard : l'accueil ne
 *   s'affiche qu'une seule fois par journée logique et par machine ;
 * - sinon → accueil.
 */
export type LandingTarget = "/setup" | "/today" | "/dashboard";

export interface LandingInput {
  readonly hasVault: boolean;
  readonly openDashboardOnLaunch: boolean;
  readonly startedToday: boolean;
}

export function resolveLanding(input: LandingInput): LandingTarget {
  if (!input.hasVault) return "/setup";
  if (input.openDashboardOnLaunch) return "/dashboard";
  if (input.startedToday) return "/dashboard";
  return "/today";
}

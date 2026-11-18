export interface KeyedWarning {
  readonly key: string;
  readonly message: string;
}

/**
 * Attribue une clé React stable à chaque avertissement sans utiliser l'index
 * du tableau. Les doublons exacts restent affichés, discriminés par leur
 * occurrence (l'ordre de lecture est conservé).
 */
export function keyWarnings(warnings: readonly string[]): KeyedWarning[] {
  const occurrences = new Map<string, number>();
  return warnings.map((message) => {
    const occurrence = (occurrences.get(message) ?? 0) + 1;
    occurrences.set(message, occurrence);
    return { key: `${message}\u0000${occurrence}`, message };
  });
}

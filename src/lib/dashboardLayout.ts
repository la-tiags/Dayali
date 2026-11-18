import type { WidgetPlacement } from "./contracts/types";

/** Grille du dashboard : 12 colonnes (invariant du schéma), hauteurs en lignes de `rowHeight` px. */
export const GRID_COLUMNS = 12;
export const MIN_WIDGET_W = 2;
export const MIN_WIDGET_H = 2;
export const MAX_WIDGET_H = 24;
const MAX_ROW = 1000;

export type WidgetLayout = WidgetPlacement["layout"];
export type MoveDirection = "up" | "down" | "left" | "right";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Deux rectangles de la grille se recouvrent-ils ? (les bords qui se touchent ne comptent pas) */
export function overlaps(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Ramène un placement dans les bornes de la grille (x + w <= 12, tailles min/max). */
export function clampLayout(layout: WidgetLayout): WidgetLayout {
  const w = clamp(Math.round(layout.w), MIN_WIDGET_W, GRID_COLUMNS);
  const h = clamp(Math.round(layout.h), MIN_WIDGET_H, MAX_WIDGET_H);
  return {
    x: clamp(Math.round(layout.x), 0, GRID_COLUMNS - w),
    y: clamp(Math.round(layout.y), 0, MAX_ROW),
    w,
    h,
  };
}

/** Redimensionne en gardant le coin haut-gauche : la largeur ne peut pas dépasser le bord droit. */
export function resizeLayout(layout: WidgetLayout, w: number, h: number): WidgetLayout {
  return {
    ...layout,
    w: clamp(Math.round(w), MIN_WIDGET_W, GRID_COLUMNS - layout.x),
    h: clamp(Math.round(h), MIN_WIDGET_H, MAX_WIDGET_H),
  };
}

/** Déplace d'une cellule, sans sortir de la grille. */
export function moveLayout(layout: WidgetLayout, direction: MoveDirection): WidgetLayout {
  switch (direction) {
    case "up":
      return { ...layout, y: Math.max(0, layout.y - 1) };
    case "down":
      return { ...layout, y: Math.min(MAX_ROW, layout.y + 1) };
    case "left":
      return { ...layout, x: Math.max(0, layout.x - 1) };
    case "right":
      return { ...layout, x: Math.min(GRID_COLUMNS - layout.w, layout.x + 1) };
  }
}

/** Premier emplacement libre (de haut en bas, puis de gauche à droite) à partir de `minY`. */
export function findFreeSlot(
  occupied: readonly WidgetLayout[],
  w: number,
  h: number,
  minY = 0,
): { x: number; y: number } {
  for (let y = minY; y <= MAX_ROW; y += 1) {
    for (let x = 0; x <= GRID_COLUMNS - w; x += 1) {
      const candidate = { x, y, w, h };
      if (!occupied.some((other) => overlaps(other, candidate))) {
        return { x, y };
      }
    }
  }
  return { x: 0, y: MAX_ROW };
}

function byPosition(a: WidgetPlacement, b: WidgetPlacement): number {
  return a.layout.y - b.layout.y || a.layout.x - b.layout.x;
}

function restoreOrder(
  original: readonly WidgetPlacement[],
  placed: Map<string, WidgetPlacement>,
): WidgetPlacement[] {
  return original.map((widget) => placed.get(widget.id) ?? widget);
}

/**
 * Répare une disposition qui se chevauche (ex. widgets créés tous en 0,0) : un widget
 * qui en recouvre un autre est replacé dans le premier emplacement libre à sa hauteur
 * ou en dessous. Une disposition valide est renvoyée à l'identique.
 */
export function healLayout(widgets: readonly WidgetPlacement[]): WidgetPlacement[] {
  const placed = new Map<string, WidgetPlacement>();
  const occupied: WidgetLayout[] = [];
  const clamped = widgets.map((widget) => ({ ...widget, layout: clampLayout(widget.layout) }));
  for (const widget of [...clamped].sort(byPosition)) {
    const { layout } = widget;
    const next = occupied.some((other) => overlaps(other, layout))
      ? { ...layout, ...findFreeSlot(occupied, layout.w, layout.h, layout.y) }
      : layout;
    occupied.push(next);
    placed.set(widget.id, { ...widget, layout: next });
  }
  return restoreOrder(widgets, placed);
}

/**
 * Applique une modification utilisateur : le widget `anchorId` garde sa place et les autres
 * sont repoussés vers le bas s'ils le gênent (comme une grille de dashboard classique).
 */
export function resolveLayout(
  widgets: readonly WidgetPlacement[],
  anchorId?: string,
): WidgetPlacement[] {
  const clamped = widgets.map((widget) => ({ ...widget, layout: clampLayout(widget.layout) }));
  const ordered = [...clamped].sort((a, b) => {
    if (a.id === anchorId) return -1;
    if (b.id === anchorId) return 1;
    return byPosition(a, b);
  });
  const placed = new Map<string, WidgetPlacement>();
  const occupied: WidgetLayout[] = [];
  for (const widget of ordered) {
    let y = widget.layout.y;
    for (;;) {
      const candidate = { ...widget.layout, y };
      const blocker = occupied.find((other) => overlaps(other, candidate));
      if (!blocker) break;
      y = blocker.y + blocker.h;
    }
    const layout = { ...widget.layout, y: Math.min(y, MAX_ROW) };
    occupied.push(layout);
    placed.set(widget.id, { ...widget, layout });
  }
  return restoreOrder(widgets, placed);
}

/** Nouvelle disposition après redimensionnement de `id` (les voisins gênés descendent). */
export function applyResize(
  widgets: readonly WidgetPlacement[],
  id: string,
  w: number,
  h: number,
): WidgetPlacement[] {
  const healed = healLayout(widgets).map((widget) =>
    widget.id === id ? { ...widget, layout: resizeLayout(widget.layout, w, h) } : widget,
  );
  return resolveLayout(healed, id);
}

/** Nouvelle disposition après déplacement de `id` d'une cellule. */
export function applyMove(
  widgets: readonly WidgetPlacement[],
  id: string,
  direction: MoveDirection,
): WidgetPlacement[] {
  const healed = healLayout(widgets).map((widget) =>
    widget.id === id ? { ...widget, layout: moveLayout(widget.layout, direction) } : widget,
  );
  return resolveLayout(healed, id);
}

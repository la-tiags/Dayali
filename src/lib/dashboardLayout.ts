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
 * Réorganise automatiquement : le widget `anchorId` (celui que l'utilisateur
 * déplace ou redimensionne) garde sa place, tous les autres remontent au plus
 * haut (gravité) en contournant les widgets déjà posés. Sans ancre, tout le
 * monde remonte, y compris le widget qu'on vient de lâcher. Aucun trou, aucun
 * chevauchement, et l'utilisateur n'a jamais à penser à la grille.
 */
export function compactLayout(
  widgets: readonly WidgetPlacement[],
  anchorId?: string,
): WidgetPlacement[] {
  const clamped = widgets.map((widget) => ({ ...widget, layout: clampLayout(widget.layout) }));
  const placed = new Map<string, WidgetPlacement>();
  const occupied: WidgetLayout[] = [];
  const anchor = anchorId ? clamped.find((widget) => widget.id === anchorId) : undefined;
  if (anchor) {
    occupied.push(anchor.layout);
    placed.set(anchor.id, anchor);
  }
  for (const widget of clamped.filter((candidate) => candidate !== anchor).sort(byPosition)) {
    let y = 0;
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

/** Applique une modification utilisateur (voir `compactLayout`). */
export function resolveLayout(
  widgets: readonly WidgetPlacement[],
  anchorId?: string,
): WidgetPlacement[] {
  return compactLayout(widgets, anchorId);
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

/** Nouvelle disposition après déplacement direct de `id` à la position (x, y) au curseur. */
export function applyPosition(
  widgets: readonly WidgetPlacement[],
  id: string,
  x: number,
  y: number,
): WidgetPlacement[] {
  const healed = healLayout(widgets).map((widget) =>
    widget.id === id ? { ...widget, layout: clampLayout({ ...widget.layout, x, y }) } : widget,
  );
  return resolveLayout(healed, id);
}

// ── Rendu responsive et conversions pixel ↔ cellule ───────────────────────────

/** Espace entre deux widgets, en pixels (horizontal et vertical). */
export const GRID_GAP = 16;
/** En dessous de ces largeurs de conteneur, le dashboard passe à 6 puis 1 colonne. */
const SIX_COLUMNS_MIN_WIDTH = 520;
const TWELVE_COLUMNS_MIN_WIDTH = 820;

/** Nombre de colonnes affichées selon la largeur réellement disponible. */
export function columnsForWidth(width: number): 1 | 6 | 12 {
  if (width >= TWELVE_COLUMNS_MIN_WIDTH) return 12;
  if (width >= SIX_COLUMNS_MIN_WIDTH) return 6;
  return 1;
}

/**
 * Projette la disposition (stockée sur 12 colonnes) sur moins de colonnes pour
 * les fenêtres étroites : proportions conservées, ordre de lecture conservé,
 * puis compaction. Purement visuel : rien n'est réécrit dans le vault.
 */
export function projectToColumns(
  widgets: readonly WidgetPlacement[],
  columns: 1 | 6 | 12,
): WidgetPlacement[] {
  if (columns === GRID_COLUMNS) return [...widgets];
  const ratio = columns / GRID_COLUMNS;
  const reading = [...widgets].sort(byPosition).map((widget) => {
    const w =
      columns === 1 ? 1 : Math.min(columns, Math.max(2, Math.ceil(widget.layout.w * ratio)));
    const x = columns === 1 ? 0 : Math.min(columns - w, Math.floor(widget.layout.x * ratio));
    return { ...widget, layout: { x, y: widget.layout.y, w, h: widget.layout.h } };
  });
  const flowed = compactLayoutFor(reading, columns);
  const byId = new Map(flowed.map((widget) => [widget.id, widget]));
  return widgets.map((widget) => byId.get(widget.id) ?? widget);
}

/** Compaction sur `columns` colonnes (les bornes de clamp sont celles de 12 colonnes). */
function compactLayoutFor(widgets: readonly WidgetPlacement[], columns: number): WidgetPlacement[] {
  const placed = new Map<string, WidgetPlacement>();
  const occupied: WidgetLayout[] = [];
  for (const widget of widgets) {
    const w = Math.min(widget.layout.w, columns);
    let y = 0;
    for (;;) {
      const candidate = { ...widget.layout, w, x: Math.min(widget.layout.x, columns - w), y };
      const blocker = occupied.find((other) => overlaps(other, candidate));
      if (!blocker) {
        occupied.push(candidate);
        placed.set(widget.id, { ...widget, layout: candidate });
        break;
      }
      y = blocker.y + blocker.h;
    }
  }
  return widgets.map((widget) => placed.get(widget.id) ?? widget);
}

export interface GridMetrics {
  readonly columns: number;
  /** Largeur d'une colonne, en pixels. */
  readonly columnWidth: number;
  /** Pas horizontal (colonne + espace) et vertical (ligne + espace). */
  readonly stepX: number;
  readonly stepY: number;
}

export function gridMetrics(width: number, columns: number, rowHeight: number): GridMetrics {
  const columnWidth = Math.max(1, (width - GRID_GAP * (columns - 1)) / columns);
  return { columns, columnWidth, stepX: columnWidth + GRID_GAP, stepY: rowHeight + GRID_GAP };
}

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangle en pixels d'un placement dans le conteneur. */
export function layoutToPixels(layout: WidgetLayout, metrics: GridMetrics): PixelRect {
  return {
    left: layout.x * metrics.stepX,
    top: layout.y * metrics.stepY,
    width: layout.w * metrics.stepX - GRID_GAP,
    height: layout.h * metrics.stepY - GRID_GAP,
  };
}

/** Hauteur du conteneur : le bas du widget le plus bas (au moins une ligne). */
export function boardHeight(widgets: readonly WidgetPlacement[], metrics: GridMetrics): number {
  const rows = widgets.reduce((max, widget) => Math.max(max, widget.layout.y + widget.layout.h), 1);
  return rows * metrics.stepY - GRID_GAP;
}

/** Cellule la plus proche d'une position en pixels (le coin haut-gauche d'un widget). */
export function pixelsToCell(
  left: number,
  top: number,
  metrics: GridMetrics,
): { x: number; y: number } {
  return { x: Math.round(left / metrics.stepX), y: Math.round(top / metrics.stepY) };
}

/** Taille en cellules la plus proche d'une taille en pixels. */
export function pixelsToSize(
  width: number,
  height: number,
  metrics: GridMetrics,
): { w: number; h: number } {
  return {
    w: Math.round((width + GRID_GAP) / metrics.stepX),
    h: Math.round((height + GRID_GAP) / metrics.stepY),
  };
}

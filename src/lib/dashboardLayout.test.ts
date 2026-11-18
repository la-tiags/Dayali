import { describe, expect, it } from "vitest";
import type { WidgetPlacement } from "./contracts/types";
import {
  applyMove,
  applyPosition,
  applyResize,
  clampLayout,
  findFreeSlot,
  healLayout,
  moveLayout,
  overlaps,
  resizeLayout,
  resolveLayout,
} from "./dashboardLayout";

function widget(id: string, x: number, y: number, w: number, h: number): WidgetPlacement {
  return { id, module: "reminders", viewId: "v", layout: { x, y, w, h }, enabled: true };
}

function layoutOf(widgets: WidgetPlacement[], id: string) {
  return widgets.find((candidate) => candidate.id === id)?.layout;
}

describe("dashboardLayout", () => {
  it("détecte les chevauchements mais pas les bords qui se touchent", () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 })).toBe(false);
  });

  it("garde un placement dans la grille (x + w <= 12, tailles min et max)", () => {
    expect(clampLayout({ x: 10, y: 0, w: 6, h: 1 })).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(clampLayout({ x: 0, y: -3, w: 20, h: 99 })).toEqual({ x: 0, y: 0, w: 12, h: 24 });
  });

  it("redimensionne sans dépasser le bord droit ni les bornes de hauteur", () => {
    const layout = { x: 8, y: 0, w: 4, h: 6 };
    expect(resizeLayout(layout, 9, 6)).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    expect(resizeLayout(layout, 1, 1)).toEqual({ x: 8, y: 0, w: 2, h: 2 });
    expect(resizeLayout({ x: 0, y: 0, w: 4, h: 6 }, 7, 30)).toEqual({ x: 0, y: 0, w: 7, h: 24 });
  });

  it("déplace d'une cellule sans sortir de la grille", () => {
    expect(moveLayout({ x: 0, y: 0, w: 4, h: 4 }, "left").x).toBe(0);
    expect(moveLayout({ x: 0, y: 0, w: 4, h: 4 }, "up").y).toBe(0);
    expect(moveLayout({ x: 8, y: 0, w: 4, h: 4 }, "right").x).toBe(8);
    expect(moveLayout({ x: 2, y: 3, w: 4, h: 4 }, "right")).toEqual({ x: 3, y: 3, w: 4, h: 4 });
    expect(moveLayout({ x: 2, y: 3, w: 4, h: 4 }, "down").y).toBe(4);
  });

  it("trouve le premier emplacement libre à côté d'un widget existant", () => {
    const occupied = [{ x: 0, y: 0, w: 4, h: 6 }];
    expect(findFreeSlot(occupied, 6, 6)).toEqual({ x: 4, y: 0 });
    expect(findFreeSlot(occupied, 9, 6)).toEqual({ x: 0, y: 6 });
    expect(findFreeSlot([], 4, 4)).toEqual({ x: 0, y: 0 });
  });

  it("répare des widgets tous créés en 0,0 : ils se placent côte à côte", () => {
    const healed = healLayout([widget("rappels", 0, 0, 4, 4), widget("agenda", 0, 0, 6, 4)]);
    expect(layoutOf(healed, "rappels")).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(layoutOf(healed, "agenda")).toEqual({ x: 4, y: 0, w: 6, h: 4 });
  });

  it("laisse une disposition valide strictement inchangée", () => {
    const valid = [widget("a", 0, 0, 8, 6), widget("b", 8, 0, 4, 6), widget("c", 0, 6, 6, 4)];
    expect(healLayout(valid)).toEqual(valid);
  });

  it("repousse vers le bas les voisins gênés par le widget ancré", () => {
    const resolved = resolveLayout([widget("a", 0, 0, 8, 6), widget("b", 0, 6, 6, 4)], "a");
    expect(layoutOf(resolved, "a")).toEqual({ x: 0, y: 0, w: 8, h: 6 });
    expect(layoutOf(resolved, "b")).toEqual({ x: 0, y: 6, w: 6, h: 4 });

    const grown = resolveLayout([widget("a", 0, 0, 8, 8), widget("b", 0, 6, 6, 4)], "a");
    expect(layoutOf(grown, "a")?.h).toBe(8);
    expect(layoutOf(grown, "b")?.y).toBe(8);
  });

  it("agrandir un widget ne crée jamais de chevauchement", () => {
    const next = applyResize(
      [widget("a", 0, 0, 4, 4), widget("b", 4, 0, 4, 4), widget("c", 0, 4, 12, 2)],
      "a",
      6,
      5,
    );
    expect(layoutOf(next, "a")).toEqual({ x: 0, y: 0, w: 6, h: 5 });
    for (const first of next) {
      for (const second of next) {
        if (first.id !== second.id) {
          expect(overlaps(first.layout, second.layout)).toBe(false);
        }
      }
    }
  });

  it("déplacer un widget le fait passer devant sans superposition", () => {
    const next = applyMove([widget("a", 0, 0, 4, 4), widget("b", 4, 0, 4, 4)], "b", "left");
    expect(layoutOf(next, "b")).toEqual({ x: 3, y: 0, w: 4, h: 4 });
    expect(layoutOf(next, "a")?.y).toBe(4);
  });

  it("déplace un widget directement aux coordonnées (x, y) au curseur", () => {
    const next = applyPosition([widget("a", 0, 0, 4, 4), widget("b", 4, 0, 4, 4)], "b", 0, 0);
    expect(layoutOf(next, "b")).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(layoutOf(next, "a")?.y).toBe(4);
  });

  it("conserve l'ordre du tableau et les autres champs des widgets", () => {
    const input = [widget("z", 0, 4, 4, 4), widget("a", 0, 0, 4, 4)];
    const out = applyResize(input, "a", 5, 4);
    expect(out.map((candidate) => candidate.id)).toEqual(["z", "a"]);
    expect(out[0]?.viewId).toBe("v");
    expect(out[0]?.enabled).toBe(true);
  });
});

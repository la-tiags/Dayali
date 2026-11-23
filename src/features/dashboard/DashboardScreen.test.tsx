import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/contracts/types";
import { DashboardScreen } from "./DashboardScreen";

const config: Config = {
  schemaVersion: 1,
  dayStartHour: 4,
  openDashboardOnLaunch: false,
  locale: "fr-FR",
  weekStartsOn: 1,
  dashboard: {
    columns: 12,
    rowHeight: 40,
    widgets: [
      {
        id: "w1",
        module: "reminders",
        viewId: "v1",
        title: "Ma journée",
        layout: { x: 0, y: 0, w: 8, h: 6 },
        enabled: true,
      },
      {
        id: "w2",
        module: "agenda",
        viewId: "vue-disparue",
        title: "Agenda",
        layout: { x: 8, y: 0, w: 4, h: 6 },
        enabled: true,
      },
      {
        id: "w3",
        module: "journal",
        viewId: "v1",
        title: "Journal",
        layout: { x: 0, y: 6, w: 6, h: 4 },
        enabled: false,
      },
    ],
  },
  views: [
    {
      id: "v1",
      module: "reminders",
      name: "Mes rappels du jour",
      origin: "user",
      filter: { statuses: ["open"] },
      createdAt: "2026-10-20T07:10:00.000Z",
      updatedAt: "2026-10-20T07:10:00.000Z",
    },
  ],
  appearance: { greeting: { variants: true } },
};

function renderDashboard(overrides: Partial<Parameters<typeof DashboardScreen>[0]> = {}) {
  const props = {
    config,
    logicalDate: "2026-10-26",
    onBackHome: vi.fn(),
    onOpenVaultChooser: vi.fn(),
    onOpenDashboardOnLaunchChange: vi.fn(),
    onRemoveWidget: vi.fn(),
    onToggleWidget: vi.fn(),
    onMoveWidget: vi.fn(),
    onResizeWidget: vi.fn(),
    onDragWidget: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <MemoryRouter>
      <DashboardScreen {...props} />
    </MemoryRouter>,
  );
  return { ...utils, props };
}

describe("DashboardScreen", () => {
  it("rend un widget par entrée de config.views / dashboard.widgets sans mentions superflues", () => {
    renderDashboard();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ma journée" })).toBeInTheDocument();
    expect(screen.queryByText(/Vue enregistrée/)).not.toBeInTheDocument();
  });

  it("signale une vue introuvable sans supprimer le widget", () => {
    renderDashboard();
    expect(screen.getByRole("heading", { name: "Agenda" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Vue introuvable");
    expect(screen.getByRole("status")).toHaveTextContent("Aucune donnée n'a été supprimée");
  });

  it("active le mode édition et affiche les contrôles de widgets", async () => {
    const user = userEvent.setup();
    renderDashboard();

    expect(screen.queryByRole("button", { name: "Supprimer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));
    expect(screen.getAllByRole("button", { name: "Supprimer" })).toHaveLength(3);
  });

  it("propose plusieurs vues d'agenda à l'ajout d'un widget", async () => {
    const user = userEvent.setup();
    const onAddWidget = vi.fn();
    renderDashboard({ onAddWidget });

    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));
    await user.click(screen.getByRole("button", { name: "+ Ajouter un widget" }));

    expect(screen.getByRole("menuitem", { name: /Aujourd'hui/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /7 jours/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /30 jours/ })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /Aujourd'hui/ }));
    expect(onAddWidget).toHaveBeenCalledWith({ type: "agenda", view: "day" });
  });

  it("affiche un état vide honnête quand aucun widget n'est configuré", () => {
    renderDashboard({
      config: {
        ...config,
        dashboard: { ...config.dashboard, widgets: [] },
      },
    });
    expect(screen.getByRole("heading", { name: "Le dashboard est vide" })).toBeInTheDocument();
    expect(screen.getByText(/Aucun widget n'est configuré pour le moment/)).toBeInTheDocument();
  });

  it("affiche la bannière d'invitation discrète quand la journée n'est pas démarrée et permet de l'ignorer", async () => {
    const user = userEvent.setup();
    const onBackHome = vi.fn();
    renderDashboard({ started: false, onBackHome });

    expect(
      screen.getByText("La journée n'est pas encore marquée comme démarrée sur cette machine."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revenir à l'accueil pour la démarrer" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ignorer pour l'instant" }));
    expect(screen.queryByText(/n'est pas encore marquée comme démarrée/)).not.toBeInTheDocument();
  });

  it("n'affiche pas la bannière d'invitation quand la journée est démarrée", () => {
    renderDashboard({ started: true });
    expect(screen.queryByText(/n'est pas encore marquée comme démarrée/)).not.toBeInTheDocument();
  });

  it("affiche côte à côte des widgets enregistrés au même emplacement (plus de superposition)", () => {
    renderDashboard({
      config: {
        ...config,
        dashboard: {
          ...config.dashboard,
          widgets: [
            {
              id: "rappels",
              module: "reminders",
              viewId: "v1",
              title: "Rappels",
              layout: { x: 0, y: 0, w: 4, h: 4 },
              enabled: true,
            },
            {
              id: "agenda",
              module: "agenda",
              viewId: "vue-disparue",
              title: "Agenda",
              layout: { x: 0, y: 0, w: 6, h: 4 },
              enabled: true,
            },
          ],
        },
      },
    });
    const column = (name: string) =>
      screen
        .getByRole("heading", { name })
        .closest("section")
        ?.style.getPropertyValue("--card-column");
    expect(column("Rappels")).toBe("1 / span 4");
    expect(column("Agenda")).toBe("5 / span 6");
  });

  it("affiche la poignée de redimensionnement et les repères de grille uniquement en édition", async () => {
    const user = userEvent.setup();
    renderDashboard();

    expect(screen.queryByRole("button", { name: /^Redimensionner/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));
    expect(screen.getAllByRole("button", { name: /^Redimensionner/ })).toHaveLength(3);
  });

  it("redimensionne un widget d'un cran de grille avec les flèches du clavier", async () => {
    const user = userEvent.setup();
    const { props } = renderDashboard();
    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));

    const handle = screen.getByRole("button", { name: "Redimensionner Ma journée" });
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onResizeWidget).toHaveBeenLastCalledWith("w1", 9, 6);
    await user.keyboard("{ArrowUp}");
    expect(props.onResizeWidget).toHaveBeenLastCalledWith("w1", 8, 5);
  });

  it("ne dépasse pas les bornes de la grille au clavier", async () => {
    const user = userEvent.setup();
    const { props } = renderDashboard();
    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));

    // « Agenda » occupe déjà les colonnes 9 à 12 : impossible de l'élargir vers la droite.
    const handle = screen.getByRole("button", { name: "Redimensionner Agenda" });
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onResizeWidget).not.toHaveBeenCalled();
  });

  it("permet de changer la liste associée à un widget de rappels en mode édition", async () => {
    const user = userEvent.setup();
    const onChangeWidgetList = vi.fn();
    renderDashboard({
      onChangeWidgetList,
      reminderLists: [
        {
          schemaVersion: 1,
          id: "list-ecole",
          name: "École",
          color: "#4a90e2",
          order: 0,
          archived: false,
          createdAt: "",
          updatedAt: "",
          machineId: "m1",
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));

    const select = screen.getByRole("combobox", { name: "Changer la liste pour Ma journée" });
    expect(select).toBeInTheDocument();
    await user.selectOptions(select, "list-ecole");
    expect(onChangeWidgetList).toHaveBeenCalledWith("w1", "list-ecole");
  });

  it("déplace un widget au clavier en mode édition, sans bouton « Déplacer » dédié", async () => {
    const user = userEvent.setup();
    const { props } = renderDashboard();

    const card = screen.getByRole("region", { name: "Ma journée" });
    expect(card).not.toHaveAttribute("tabindex");

    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));

    // Plus de poignée dédiée : le widget lui-même se saisit (souris) ou se focalise (clavier).
    expect(screen.queryByRole("button", { name: /Déplacer/ })).not.toBeInTheDocument();
    expect(card).toHaveAttribute("tabindex", "0");

    card.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onMoveWidget).toHaveBeenCalledWith("w1", "right");

    await user.keyboard("{ArrowDown}");
    expect(props.onMoveWidget).toHaveBeenCalledWith("w1", "down");
  });

  it("masque le bouton Fin de journée pendant la modification de la disposition", async () => {
    const user = userEvent.setup();
    renderDashboard();

    expect(screen.getByRole("button", { name: "Fin de journée" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Modifier la disposition" }));
    expect(screen.queryByRole("button", { name: "Fin de journée" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Terminer la modification" }));
    expect(screen.getByRole("button", { name: "Fin de journée" })).toBeInTheDocument();
  });
});

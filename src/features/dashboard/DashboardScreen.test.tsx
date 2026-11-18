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
});

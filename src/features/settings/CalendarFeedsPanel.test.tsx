import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureIpc, resetIpc } from "../../lib/ipc";
import { createMockIpc } from "../../lib/ipc/mock";
import { CalendarFeedsPanel } from "./CalendarFeedsPanel";

const NOW = new Date("2026-11-22T10:00:00.000Z");

function setup() {
  const ipc = createMockIpc({ timeZone: "Europe/Paris", now: () => NOW });
  configureIpc(ipc);
  render(<CalendarFeedsPanel />);
  return ipc;
}

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Ajouter un calendrier" }));
}

async function fill(user: ReturnType<typeof userEvent.setup>, name: string, url: string) {
  await user.type(screen.getByLabelText("Nom du calendrier"), name);
  await user.type(screen.getByLabelText("Adresse du calendrier (iCal)"), url);
}

describe("CalendarFeedsPanel", () => {
  beforeEach(() => resetIpc());
  afterEach(() => resetIpc());

  it("indique qu'aucun calendrier n'est ajouté", async () => {
    setup();
    expect(
      await screen.findByText("Aucun calendrier en ligne pour l'instant."),
    ).toBeInTheDocument();
  });

  it("exige de choisir public ou privé avant de pouvoir ajouter", async () => {
    const user = userEvent.setup();
    setup();
    await openForm(user);
    await fill(user, "Jours fériés", "https://exemple.org/feries.ics");

    const submit = screen.getByRole("button", { name: "Ajouter le calendrier" });
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Public/ }));
    expect(submit).toBeEnabled();
  });

  it("ajoute un calendrier public et l'affiche avec son badge", async () => {
    const user = userEvent.setup();
    const ipc = setup();
    await openForm(user);
    await fill(user, "Jours fériés", "webcal://exemple.org/feries.ics");
    await user.click(screen.getByRole("radio", { name: /Public/ }));
    await user.click(screen.getByRole("radio", { name: "Bleu" }));
    await user.click(screen.getByRole("button", { name: "Ajouter le calendrier" }));

    expect(await screen.findByText("Jours fériés")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText(/exemple\.org/)).toBeInTheDocument();
    const [feed] = await ipc.calendarFeedList();
    expect(feed?.url).toBe("https://exemple.org/feries.ics");
    expect(feed?.visibility).toBe("public");
    expect(feed?.color).toBe("#4f8cf7");
  });

  it("déconseille un calendrier privé, exige une confirmation et masque son adresse", async () => {
    const user = userEvent.setup();
    const ipc = setup();
    await openForm(user);
    await fill(user, "Agenda perso", "https://calendar.example.com/prive/jeton-secret/basic.ics");
    await user.click(screen.getByRole("radio", { name: /Privé/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nous vous recommandons de ne pas encore ajouter de calendrier privé.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("n'est pas chiffrée");
    expect(screen.getByRole("alert")).toHaveTextContent("en clair");

    const submit = screen.getByRole("button", { name: "Ajouter le calendrier" });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /adresse sera stockée sans chiffrement/ }),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Agenda perso")).toBeInTheDocument();
    expect(screen.getByText("Privé")).toBeInTheDocument();
    expect(screen.getByText(/Adresse privée/)).toBeInTheDocument();
    expect(screen.queryByText(/jeton-secret/)).not.toBeInTheDocument();
    expect((await ipc.calendarFeedList())[0]?.visibility).toBe("private");
  });

  it("affiche l'erreur renvoyée quand l'adresse est refusée", async () => {
    const user = userEvent.setup();
    setup();
    await openForm(user);
    await fill(user, "Cassé", "ceci n'est pas une adresse");
    await user.click(screen.getByRole("radio", { name: /Public/ }));
    await user.click(screen.getByRole("button", { name: "Ajouter le calendrier" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "L'adresse doit commencer par https://",
    );
    expect(screen.queryByText("Cassé")).not.toBeInTheDocument();
  });

  it("supprime un calendrier après confirmation", async () => {
    const user = userEvent.setup();
    const ipc = setup();
    await ipc.calendarFeedAdd({
      name: "Sport",
      url: "https://exemple.org/sport.ics",
      visibility: "public",
    });
    render(<CalendarFeedsPanel />);

    const remove = await screen.findByRole("button", { name: "Supprimer Sport" });
    await user.click(remove);
    await user.click(screen.getByRole("button", { name: "Confirmer la suppression de Sport" }));

    await waitFor(async () => expect(await ipc.calendarFeedList()).toHaveLength(0));
  });
});

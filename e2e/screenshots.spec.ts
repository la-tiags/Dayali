import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

test.use({
  locale: "fr-FR",
  timezoneId: "Europe/Paris",
});

interface AxeReportNode {
  target: string[];
  html: string;
  failureSummary?: string;
  contrastRatio?: number;
}

interface AxeReportRule {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  nodes: AxeReportNode[];
}

interface ScreenA11yEntry {
  violations: AxeReportRule[];
  incomplete: AxeReportRule[];
}

const allA11yReports: Record<string, ScreenA11yEntry> = {};

async function checkA11y(page: any, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const formatRule = (r: any): AxeReportRule => ({
    id: r.id,
    impact: r.impact,
    description: r.description,
    help: r.help,
    nodes: r.nodes.map((n: any) => {
      const contrastData = n.any?.find((a: any) => a.id === "color-contrast")?.data as { contrastRatio?: number } | undefined;
      return {
        target: n.target,
        html: n.html,
        failureSummary: n.failureSummary,
        ...(contrastData?.contrastRatio !== undefined ? { contrastRatio: contrastData.contrastRatio } : {}),
      };
    }),
  });

  const entry: ScreenA11yEntry = {
    violations: results.violations.map(formatRule),
    incomplete: results.incomplete.map(formatRule),
  };
  allA11yReports[name] = entry;

  const count = entry.violations.length;
  console.log(`[A11Y] ${name}: ${count} violation(s), ${results.passes.length} passes, ${entry.incomplete.length} incomplete`);
  if (count > 0) {
    for (const v of entry.violations) {
      console.log(`  - [${v.id}] ${v.help} (${v.nodes.length} nodes)`);
      for (const n of v.nodes) {
        console.log(`      ${n.target.join(", ")}`);
      }
    }
  }

  // Le script DOIT échouer s'il reste une violation Axe
  expect(entry.violations, `A11y violations on ${name}`).toEqual([]);
  return entry;
}

function updateIndexMd(_outDir: string) {
  const indexFile = path.resolve("docs/screenshots/INDEX.md");
  const today = new Date().toISOString().split("T")[0];
  const content = `# Captures d'écran de Dayali (docs/screenshots/)

Ce dossier contient les captures d'écran de référence de l'application Dayali, générées automatiquement le ${today} par le script Playwright WebKit (résolutions 1280x800 et 900x640).

## Liste des captures

| Nom du fichier (1280x800) | Nom du fichier (900x640) | Écran / Vue | Description |
|---|---|---|---|
| \`01-vault-setup-vide.png\` | \`01-vault-setup-vide-900x640.png\` | Sélection / Création de Vault | Écran initial de configuration du vault (vide) |
| \`01-vault-setup-etape-1-nom.png\` | \`01-vault-setup-etape-1-nom-900x640.png\` | Wizard Vault - Nom | Saisie du nom du nouveau vault |
| \`01-vault-setup-etape-2-chemin.png\` | \`01-vault-setup-etape-2-chemin-900x640.png\` | Wizard Vault - Chemin | Configuration du chemin de stockage |
| \`02-accueil-avant.png\` | \`02-accueil-avant-900x640.png\` | Accueil (Matin / Avant le début) | Accueil avant le démarrage de la journée (citation, photo, bouton de démarrage) |
| \`03-accueil-apres.png\` | \`03-accueil-apres-900x640.png\` | Accueil (Aperçu / Après démarrage) | Aperçu du jour après le démarrage de la journée (agenda, rappels, résumé) |
| \`04-dashboard.png\` | \`04-dashboard-900x640.png\` | Dashboard | Tableau de bord principal avec widgets configurés |
| \`05-fin-de-journee.png\` | \`05-fin-de-journee-900x640.png\` | Fin de journée | Bilan de fin de journée, reports et journal |
| \`05-fin-de-journee-erreur-partielle.png\` | \`05-fin-de-journee-erreur-partielle-900x640.png\` | Fin de journée (Erreur) | Gestion des erreurs partielles et synchronisation |
| \`06-rappels.png\` | \`06-rappels-900x640.png\` | Rappels | Module plein écran de gestion des rappels |
| \`06-rappels-panneau-i.png\` | \`06-rappels-panneau-i-900x640.png\` | Rappels (Panneau d'infos) | Panneau latéral des propriétés du rappel sélectionné |
| \`07-calendrier.png\` | \`07-calendrier-900x640.png\` | Calendrier | Module plein écran d'agenda / calendrier |
| \`07-calendrier-jour.png\` | \`07-calendrier-jour-900x640.png\` | Calendrier (Vue Jour) | Vue journalière de l'agenda |
| \`07-calendrier-semaine.png\` | \`07-calendrier-semaine-900x640.png\` | Calendrier (Vue Semaine) | Vue hebdomadaire de l'agenda |
| \`07-calendrier-mois.png\` | \`07-calendrier-mois-900x640.png\` | Calendrier (Vue Mois) | Vue mensuelle de l'agenda |
| \`08-reglages.png\` | \`08-reglages-900x640.png\` | Réglages | Écran des réglages et préférences de l'application |
| \`09-ecran-cloture.png\` | \`09-ecran-cloture-900x640.png\` | Écran de clôture | Écran de confirmation de fin de journée |

## Génération

Pour regénérer les captures d'écran :
\`\`\`bash
pnpm screenshots
\`\`\`
`;
  fs.writeFileSync(indexFile, content, "utf8");
}

test.describe("Dayali Screenshots & A11y Generation", () => {
  test("generate screenshots across viewports and check accessibility", async ({ page }, testInfo) => {
    const is900 = testInfo.project.name.includes("900");
    const suffix = is900 ? "-900x640" : "";
    const outDir = path.resolve("docs/screenshots");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // 1. Vault Setup (vide / sans vault ouvert) & Wizard steps
    await page.goto("/#/setup");
    await page.waitForSelector('[data-testid="vault-setup-screen"]', { state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outDir, `01-vault-setup-vide${suffix}.png`), fullPage: true });
    await checkA11y(page, "Vault Setup Vide");

    // Wizard step 1 (Nouveau vault - nom)
    const createButton = page.getByRole("button", { name: "Créer un nouveau vault", exact: true });
    if (await createButton.isVisible()) {
      await createButton.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, `01-vault-setup-etape-1-nom${suffix}.png`), fullPage: true });

      // Fill name and continue
      const nameInput = page.getByRole("textbox").first();
      if (await nameInput.isVisible()) {
        await nameInput.fill("Mon Vault Test");
        const nextBtn = page.getByRole("button", { name: /continuer|suivant/i });
        if (await nextBtn.isVisible()) {
          await nextBtn.click();
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(outDir, `01-vault-setup-etape-2-chemin${suffix}.png`), fullPage: true });
        }
      }
    }

    // 2. Accueil - Avant le début de journée
    page.on("console", (msg) => console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`[BROWSER PAGEERROR] ${err.message}`));
    page.on("requestfailed", (req) => console.log(`[BROWSER REQUEST FAILED] ${req.url()}`));

    await page.goto("/#/today");
    await page.waitForSelector('[data-testid="home-background"]', { state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `02-accueil-avant${suffix}.png`), fullPage: true });
    await checkA11y(page, "Accueil Avant");

    // 3. Accueil - Après / Aperçu du jour
    const urlBefore = page.url();
    const startButton = page.getByRole("button", { name: "Démarrer la journée", exact: true });
    await expect(startButton).toBeVisible();
    const btnText = await startButton.innerText();
    console.log(`[DIAGNOSTIC] btnText: "${btnText}", urlBefore: ${urlBefore}`);
    await startButton.click({ force: true });
    await page.waitForTimeout(2000);
    const urlAfter = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.split("\n").slice(0, 40).join("\n"));
    console.log(`[DIAGNOSTIC] urlAfter: ${urlAfter}`);
    console.log(`[DIAGNOSTIC] document.body.innerText:\n${bodyText}`);

    // Assertions strictes de contenu : bouton absent, aperçu et sections visibles
    await expect(page.getByRole("button", { name: "Démarrer la journée", exact: true })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Votre journée" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Rappels du jour" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agenda du jour" })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `03-accueil-apres${suffix}.png`), fullPage: true });
    await checkA11y(page, "Accueil Après (Aperçu)");

    // 4. Dashboard
    await page.goto("/#/dashboard");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `04-dashboard${suffix}.png`), fullPage: true });
    await checkA11y(page, "Dashboard");

    // 5. Fin de journée
    await page.goto("/#/end-of-day");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "Fin de journée", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /tâches non terminées/i })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `05-fin-de-journee${suffix}.png`), fullPage: true });
    await checkA11y(page, "Fin de journée");

    // 5b. Fin de journée - Erreur partielle
    // Simulation d'un conflit disque lors du report d'une tâche
    await page.evaluate(() => {
      (window as any).__FAIL_REMINDER_REPORT__ = true;
    });
    const postponeBtn = page.getByRole("button", { name: /reporter à demain/i }).first();
    await expect(postponeBtn).toBeVisible();
    await postponeBtn.click({ force: true });
    await page.waitForTimeout(500);

    // Assertion stricte : un message d'erreur de ligne visible (role=alert)
    const alertBox = page.getByRole("alert").first();
    await expect(alertBox).toBeVisible();
    await expect(alertBox).toContainText("Conflit disque simulé");
    await page.screenshot({ path: path.join(outDir, `05-fin-de-journee-erreur-partielle${suffix}.png`), fullPage: true });
    await checkA11y(page, "Fin de journée Erreur partielle");

    // 5c. Clôture de fin de journée
    await page.evaluate(() => {
      (window as any).__FAIL_REMINDER_REPORT__ = false;
    });
    const finishBtn = page.getByRole("button", { name: /bonne soirée/i });
    await expect(finishBtn).toBeVisible();
    await finishBtn.click({ force: true });
    await page.waitForTimeout(1000);

    // Assertion stricte : titre de clôture visible et formulaire de bilan absent
    await expect(page.getByRole("heading", { name: /bonne soirée/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /tâches non terminées/i })).not.toBeVisible();
    await page.screenshot({ path: path.join(outDir, `09-ecran-cloture${suffix}.png`), fullPage: true });
    await checkA11y(page, "Écran de clôture");

    // 6. Rappels & Panneau (i)
    await page.goto("/#/reminders");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "Rappels", level: 1 })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `06-rappels${suffix}.png`), fullPage: true });
    await checkA11y(page, "Rappels");

    const infoBtn = page.locator('[data-testid="reminder-info-btn"]').first();
    await expect(infoBtn).toBeVisible();
    await infoBtn.click({ force: true });
    await page.waitForTimeout(500);

    // Assertion stricte : le dialogue/panneau avancé est ouvert
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Propriétés avancées du rappel")).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `06-rappels-panneau-i${suffix}.png`), fullPage: true });
    await checkA11y(page, "Rappels Panneau (i)");

    // Fermer le dialogue pour rétablir l'état normal
    await page.keyboard.press("Escape").catch(() => {});

    // 7. Calendrier (Vues Jour, Semaine, Mois)
    await page.goto("/#/calendar");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "Agenda", level: 1 })).toBeVisible();
    await expect(page.locator('[data-testid="calendar-grid"]')).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `07-calendrier${suffix}.png`), fullPage: true });
    await checkA11y(page, "Calendrier");

    // Vue Jour
    const dayViewBtn = page.getByRole("tab", { name: "Jour", exact: true });
    await expect(dayViewBtn).toBeVisible();
    await dayViewBtn.click({ force: true });
    await page.waitForTimeout(500);
    await expect(dayViewBtn).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="calendar-grid"]')).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `07-calendrier-jour${suffix}.png`), fullPage: true });
    await checkA11y(page, "Calendrier Jour");

    // Vue Semaine
    const weekViewBtn = page.getByRole("tab", { name: "Semaine", exact: true });
    await expect(weekViewBtn).toBeVisible();
    await weekViewBtn.click({ force: true });
    await page.waitForTimeout(500);
    await expect(weekViewBtn).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="calendar-grid"]')).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `07-calendrier-semaine${suffix}.png`), fullPage: true });
    await checkA11y(page, "Calendrier Semaine");

    // Vue Mois
    const monthViewBtn = page.getByRole("tab", { name: "Mois", exact: true });
    await expect(monthViewBtn).toBeVisible();
    await monthViewBtn.click({ force: true });
    await page.waitForTimeout(500);
    await expect(monthViewBtn).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="calendar-grid"]')).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `07-calendrier-mois${suffix}.png`), fullPage: true });
    await checkA11y(page, "Calendrier Mois");

    // 8. Réglages
    await page.goto("/#/settings");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "Réglages", level: 1 })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, `08-reglages${suffix}.png`), fullPage: true });
    await checkA11y(page, "Réglages");

    // Contrôle d'unicité binaire : des captures censées être différentes ne doivent pas être octet-identiques
    const pairsToCheck = [
      [`02-accueil-avant${suffix}.png`, `03-accueil-apres${suffix}.png`],
      [`05-fin-de-journee${suffix}.png`, `05-fin-de-journee-erreur-partielle${suffix}.png`],
      [`05-fin-de-journee${suffix}.png`, `09-ecran-cloture${suffix}.png`],
      [`05-fin-de-journee-erreur-partielle${suffix}.png`, `09-ecran-cloture${suffix}.png`],
      [`06-rappels${suffix}.png`, `06-rappels-panneau-i${suffix}.png`],
      [`07-calendrier-jour${suffix}.png`, `07-calendrier-semaine${suffix}.png`],
      [`07-calendrier-semaine${suffix}.png`, `07-calendrier-mois${suffix}.png`],
    ];
    for (const [fileA, fileB] of pairsToCheck) {
      const pathA = path.join(outDir, fileA);
      const pathB = path.join(outDir, fileB);
      if (fs.existsSync(pathA) && fs.existsSync(pathB)) {
        const bufA = fs.readFileSync(pathA);
        const bufB = fs.readFileSync(pathB);
        expect(bufA.equals(bufB), `Les fichiers ${fileA} et ${fileB} ne doivent pas être identiques (${bufA.length} octets)`).toBe(false);
      }
    }

    // Save axe report (merge across parallel workers)
    const reportPath = path.resolve("docs/screenshots/axe-report.json");
    let existingReports: Record<string, ScreenA11yEntry> = {};
    if (fs.existsSync(reportPath)) {
      try {
        existingReports = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      } catch {}
    }
    const merged = { ...existingReports, ...allA11yReports };
    fs.writeFileSync(reportPath, JSON.stringify(merged, null, 2), "utf8");

    // Update index.md automatically
    updateIndexMd(outDir);
  });
});

import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { BootstrapGate } from "../src/app/BootstrapGate";
import { Providers } from "../src/app/providers";
import { routes } from "../src/app/router";
import { resetAppStore } from "../src/stores/app.store";

/** Monte l'application complète (bootstrap + routes) sur un memory router. */
export function renderApp(initialEntries: readonly string[] = ["/"]) {
  resetAppStore();
  const router = createMemoryRouter(routes, { initialEntries: [...initialEntries] });
  const utils = render(
    <Providers>
      <BootstrapGate>
        <RouterProvider router={router} />
      </BootstrapGate>
    </Providers>,
  );
  return { router, ...utils };
}

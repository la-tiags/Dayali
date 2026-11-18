import { createHashRouter } from "react-router";
import { EndOfDayScreen } from "../features/end-of-day/EndOfDayScreen";
import { CalendarRoute } from "../routes/calendar";
import { DashboardRoute } from "../routes/dashboard";
import { RemindersRoute } from "../routes/reminders";
import { SettingsRoute } from "../routes/settings";
import { SetupRoute } from "../routes/setup";
import { TodayRoute } from "../routes/today";
import { LandingRedirect, RequireVault } from "./guards";

export const routes = [
  { path: "/", element: <LandingRedirect /> },
  { path: "/today", element: <TodayRoute /> },
  {
    path: "/dashboard",
    element: (
      <RequireVault>
        <DashboardRoute />
      </RequireVault>
    ),
  },
  {
    path: "/end-of-day",
    element: (
      <RequireVault>
        <EndOfDayScreen />
      </RequireVault>
    ),
  },
  {
    path: "/calendar",
    element: (
      <RequireVault>
        <CalendarRoute />
      </RequireVault>
    ),
  },
  {
    path: "/reminders",
    element: (
      <RequireVault>
        <RemindersRoute />
      </RequireVault>
    ),
  },
  {
    path: "/settings",
    element: (
      <RequireVault>
        <SettingsRoute />
      </RequireVault>
    ),
  },
  { path: "/setup", element: <SetupRoute /> },
];

export const router = createHashRouter(routes);

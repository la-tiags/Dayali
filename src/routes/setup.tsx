import { useCallback } from "react";
import { useNavigate } from "react-router";
import { VaultSetupScreen } from "../features/vault/VaultSetupScreen";
import { pickDirectory } from "../lib/ipc/dialog";
import { userMessage } from "../lib/ipc/errors";
import { useAppStore } from "../stores/app.store";

/** Route de choix / création de vault. */
export function SetupRoute() {
  const navigate = useNavigate();
  const machineLocal = useAppStore((state) => state.machineLocal);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const bootError = useAppStore((state) => state.bootError);
  const openVault = useAppStore((state) => state.openVault);
  const createVault = useAppStore((state) => state.createVault);
  const dismissError = useAppStore((state) => state.dismissError);
  const dismissBootError = useAppStore((state) => state.dismissBootError);

  const handleOpen = useCallback(
    async (path: string) => {
      const opened = await openVault(path);
      if (opened) navigate("/", { replace: true });
    },
    [navigate, openVault],
  );

  const handleCreate = useCallback(
    async (parentPath: string, name: string) => {
      const created = await createVault(parentPath, name);
      if (created) navigate("/", { replace: true });
    },
    [createVault, navigate],
  );

  const activeError = bootError ?? error;

  return (
    <VaultSetupScreen
      recentVaults={machineLocal?.recentVaults ?? []}
      lastVaultPath={machineLocal?.lastVaultPath ?? null}
      busy={busy}
      error={activeError ? userMessage(activeError) : null}
      errorCode={activeError?.code ?? null}
      errorDetails={activeError?.details ?? null}
      pickDirectory={pickDirectory}
      onOpenVault={(path) => void handleOpen(path)}
      onCreateVault={(parentPath, name) => void handleCreate(parentPath, name)}
      onDismissError={() => {
        dismissBootError();
        dismissError();
      }}
    />
  );
}

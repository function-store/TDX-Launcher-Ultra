// Browser-demo shim for @tauri-apps/plugin-updater: never an update.

export type Update = {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall: () => Promise<void>;
};

export async function check(): Promise<Update | null> {
  return null;
}

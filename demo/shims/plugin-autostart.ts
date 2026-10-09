// Browser-demo shim for @tauri-apps/plugin-autostart — persisted per browser.

const KEY = "tdxlu-demo-autostart";

export async function isEnabled(): Promise<boolean> {
  return localStorage.getItem(KEY) === "1";
}

export async function enable(): Promise<void> {
  localStorage.setItem(KEY, "1");
}

export async function disable(): Promise<void> {
  localStorage.removeItem(KEY);
}

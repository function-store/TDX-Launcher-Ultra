// Browser-demo shim for @tauri-apps/plugin-process.

export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function exit(_code?: number): Promise<void> {}

// Browser-demo shim for @crabnebula/tauri-plugin-drag.
// A browser tab can't start an OS file drag; surface that in the status bar.

export async function startDrag(_options: unknown): Promise<void> {
  throw new Error(
    "OS drag-out isn't possible in the browser demo — in the real app this drops the .tox straight into a TouchDesigner network.",
  );
}

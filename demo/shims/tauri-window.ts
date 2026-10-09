// Browser-demo shim for @tauri-apps/api/window.
// The demo has no OS window; size calls are no-ops and the "window" is the tab.

class MockWindow {
  async setSize(_size: unknown): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async setFocus(): Promise<void> {}
  async close(): Promise<void> {}
  async minimize(): Promise<void> {}
  async outerSize(): Promise<{ width: number; height: number }> {
    const scale = window.devicePixelRatio || 1;
    return { width: window.innerWidth * scale, height: window.innerHeight * scale };
  }
  async scaleFactor(): Promise<number> {
    return window.devicePixelRatio || 1;
  }
  /** OS drag-drop of files never reaches a browser tab — never fires. */
  async onDragDropEvent(_cb: unknown): Promise<() => void> {
    return () => {};
  }
  /** Browser tabs have no OS focus lifecycle worth mirroring — never fires. */
  async onFocusChanged(_cb: unknown): Promise<() => void> {
    return () => {};
  }
  async center(): Promise<void> {}
}

const current = new MockWindow();

export function getCurrentWindow(): MockWindow {
  return current;
}

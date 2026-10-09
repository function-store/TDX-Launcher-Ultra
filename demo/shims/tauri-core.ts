// Browser-demo shim for @tauri-apps/api/core — invoke goes to the mock backend.

import { mockInvoke } from "../mock/backend";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await mockInvoke(cmd, args)) as T;
}

/**
 * In the demo every "file path" that reaches the DOM is already a data: URL
 * or a web path, so pass it through untouched.
 */
export function convertFileSrc(filePath: string, _protocol = "asset"): string {
  return filePath;
}

export function isTauri(): boolean {
  return false;
}

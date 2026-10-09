/** Editable keyboard shortcuts: named actions with defaults + an accelerator
 *  format shared between capture (recording) and matching. */

import { FNS_ENABLED } from "./features";

export type ActionId =
  | "tab.recent"
  | "tab.current"
  | "tab.templates"
  | "tab.palette"
  | "tab.fns"
  | "tab.patreon"
  | "search"
  | "windows.switcher"
  | "settings"
  | "help"
  | "refresh"
  | "launch.default"
  | "toggle.versions"
  | "toggle.icons"
  | "toggle.readme"
  | "toggle.touchplayer"
  | "reveal.folder"
  | "readme.edit"
  | "readme.save"
  | "panel.info"
  | "panel.git"
  | "panel.backup"
  | "panel.heartbeat"
  | "panel.mcp";

export interface EditableAction {
  id: ActionId;
  label: string;
  default: string;
  /** Only meaningful when the Patreon build is enabled. */
  patreonOnly?: boolean;
  /** Only meaningful while the FNSTools surface is enabled. */
  fnsOnly?: boolean;
}

export const EDITABLE_ACTIONS: EditableAction[] = [
  { id: "tab.recent", label: "Go to Recent tab", default: "Alt+1" },
  { id: "tab.current", label: "Go to Sessions tab", default: "Alt+2" },
  { id: "tab.templates", label: "Go to Templates tab", default: "Alt+3" },
  { id: "tab.palette", label: "Go to Palette tab", default: "Alt+4" },
  { id: "tab.patreon", label: "Go to Patreon tab", default: "Alt+5", patreonOnly: true },
  // Alt+6, not Alt+5, so an existing Patreon habit keeps working.
  { id: "tab.fns", label: "Go to FNSTools tab", default: "Alt+6", fnsOnly: true },
  { id: "search", label: "Open search", default: "Ctrl+F" },
  // Alt-based on purpose: Ctrl+W / Ctrl+Shift+W are WebView2 close-window
  // accelerators, which the host may swallow before preventDefault() runs.
  { id: "windows.switcher", label: "Find a TouchDesigner window", default: "Alt+W" },
  { id: "settings", label: "Open Settings", default: "Ctrl+," },
  { id: "help", label: "Open Help", default: "F1" },
  { id: "launch.default", label: "Launch TD on its default startup file", default: "Ctrl+D" },
  // Single-letter defaults. These only reach the app when focus is NOT in a text
  // field — see the bare-key guard in App.tsx's key handler, without which
  // typing "v" in the search box would toggle version collapsing.
  { id: "toggle.versions", label: "Toggle version collapsing", default: "V" },
  { id: "toggle.icons", label: "Toggle icons", default: "C" },
  { id: "toggle.readme", label: "Toggle the info / README panel", default: "E" },
  { id: "toggle.touchplayer", label: "Toggle TouchPlayer", default: "R" },
  { id: "reveal.folder", label: "Open the selected project's folder", default: "F" },
  { id: "readme.edit", label: "Edit README", default: "Ctrl+E" },
  { id: "readme.save", label: "Save README", default: "Ctrl+S" },
  // Unbound by default — assign if you want them.
  { id: "refresh", label: "Refresh / browse current tab", default: "" },
  { id: "panel.info", label: "Toggle Info panel", default: "" },
  { id: "panel.git", label: "Toggle Git panel", default: "" },
  { id: "panel.backup", label: "Toggle Backup panel", default: "" },
  { id: "panel.heartbeat", label: "Toggle Heartbeat panel", default: "" },
  { id: "panel.mcp", label: "Toggle Envoy panel", default: "" },
];

const MOD_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * The base (non-modifier) key, derived from `e.code` so it's layout- AND
 * modifier-independent. Critical on macOS, where Option+1 reports `e.key` as a
 * special char ("¡") rather than "1". Falls back to `e.key` for named keys.
 */
function baseKey(e: KeyboardEvent): string {
  const code = e.code;
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^F\d{1,2}$/.test(code)) return code;
  switch (code) {
    case "Comma": return ",";
    case "Period": return ".";
    case "Slash": return "/";
    case "Semicolon": return ";";
    case "Minus": return "-";
    case "Equal": return "=";
    case "Backquote": return "`";
    case "Space": return "Space";
  }
  // Named keys (Escape, Arrow*, Enter, …) — e.key is fine and readable.
  let k = e.key;
  if (k === " " || k === "Spacebar") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  return k;
}

/**
 * Canonical accelerator string for a key event — used both to record a binding
 * and to match one, so they're consistent by construction. Returns "" for a
 * bare modifier press (wait for the real key).
 */
export function formatAccel(e: KeyboardEvent): string {
  if (MOD_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(baseKey(e));
  return parts.join("+");
}

/** On macOS, Ctrl-based defaults become Cmd (Meta) — the native convention. */
export function macAdjustDefault(accel: string): string {
  return accel.replace(/\bCtrl\b/g, "Meta");
}

/** Effective binding for an action: user override, else platform default. */
export function bindingFor(
  action: EditableAction,
  overrides: Record<string, string> | undefined,
  isMac: boolean,
): string {
  const v = overrides?.[action.id];
  if (v && v.trim()) return v;
  return isMac ? macAdjustDefault(action.default) : action.default;
}

/** Map of accelerator -> actionId for the active (patreon-aware) action set. */
export function buildAccelMap(
  overrides: Record<string, string> | undefined,
  patreonEnabled: boolean,
  isMac: boolean,
): Record<string, ActionId> {
  const map: Record<string, ActionId> = {};
  for (const a of EDITABLE_ACTIONS) {
    if (a.patreonOnly && !patreonEnabled) continue;
    if (a.fnsOnly && !FNS_ENABLED) continue;
    const accel = bindingFor(a, overrides, isMac);
    if (accel) map[accel] = a.id;
  }
  return map;
}

/** Human display of an accelerator — Mac-native modifier names. */
export function displayAccel(accel: string, isMac: boolean): string {
  if (!accel || !isMac) return accel;
  return accel
    .replace(/\bMeta\b/g, "Cmd")
    .replace(/\bAlt\b/g, "Option")
    .replace(/\bCtrl\b/g, "Control");
}

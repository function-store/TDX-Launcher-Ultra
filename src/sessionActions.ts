/**
 * Canonical launcher-native actions for one TouchDesigner session.
 *
 * Surfaces decide how an action looks and how it is executed, but they do not
 * independently decide which verbs exist. Keeping availability and wording
 * here prevents the desktop card, context menu, Quick Launch, and phone fleet
 * page from drifting apart again.
 */

export type SessionActionId =
  | "focus"
  | "save"
  | "snapshot"
  | "record"
  | "heartbeat"
  | "add-to-project"
  | "relaunch"
  | "kill"
  | "dismiss"
  | "windows"
  | "reveal"
  | "copy-path"
  | "envoy";

export type SessionActionPlacement = "primary" | "detail" | "overflow";

export interface SessionActionContext {
  alive: boolean;
  hasPid: boolean;
  hasCompanion: boolean;
  hasEnvoy: boolean;
  windowCount: number;
}

export interface SessionAction {
  id: SessionActionId;
  label: string;
  placement: SessionActionPlacement;
  enabled: boolean;
  danger?: boolean;
  destructive?: boolean;
  requiresCompanion?: boolean;
}

const action = (
  id: SessionActionId,
  label: string,
  placement: SessionActionPlacement,
  enabled = true,
  extra: Partial<SessionAction> = {},
): SessionAction => ({ id, label, placement, enabled, ...extra });

export function buildSessionActions(ctx: SessionActionContext): SessionAction[] {
  if (!ctx.alive) {
    return [
      action("relaunch", "Relaunch", "primary"),
      action("dismiss", "Dismiss", "primary"),
      action("reveal", "Reveal", "overflow"),
      action("copy-path", "Copy path", "overflow"),
    ];
  }

  const actions: SessionAction[] = [
    action("focus", "Focus", "primary", ctx.hasPid),
  ];
  if (ctx.hasCompanion) {
    actions.push(
      action("save", "Save", "primary", true, { requiresCompanion: true }),
      action("snapshot", "Thumbnail", "primary", true, { requiresCompanion: true }),
      action("record", "Preview video", "primary", true, { requiresCompanion: true }),
    );
  }
  if (ctx.hasCompanion) {
    actions.push(
      // Companion only: the watchdog's pulse IS the utility's heartbeat. With
      // no utility nothing ever beats, so after the launch grace the watchdog
      // reads a healthy session as stalled -- and kills and relaunches it.
      action("heartbeat", "Heartbeat", "primary", true, { requiresCompanion: true }),
      action("add-to-project", "Add to project ▾", "primary", true, {
        requiresCompanion: true,
      }),
    );
  }
  actions.push(
    action("relaunch", "Relaunch…", "primary", true, { destructive: true }),
    action("kill", "Kill", "primary", ctx.hasPid, {
      danger: true,
      destructive: true,
    }),
  );
  if (ctx.windowCount > 0) {
    actions.push(action("windows", "Windows", "detail"));
  }
  actions.push(
    action("reveal", "Reveal", "overflow"),
    action("copy-path", "Copy path", "overflow"),
  );
  if (ctx.hasEnvoy) actions.push(action("envoy", "Open Envoy panel", "overflow"));
  return actions;
}

/** Verbs supported by Quick Launch's command rows. */
export const QUICK_SESSION_ACTION_IDS: ReadonlySet<SessionActionId> = new Set([
  "focus",
  "save",
  "snapshot",
  "record",
  "relaunch",
  "kill",
]);

/** Verbs the launcher-hosted FLEET page supports: the OS-process operations
 *  only the launcher can perform. Save / snapshot / record left with
 *  `/api/sessions/action` (D5) -- a session runs those from its own
 *  FNS_Remote page. */
export const FLEET_SESSION_ACTION_IDS: ReadonlySet<SessionActionId> = new Set([
  "focus",
  "relaunch",
  "kill",
  "dismiss",
]);

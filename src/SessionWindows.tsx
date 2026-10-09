/** Per-window navigation for running TouchDesigner sessions.
 *
 *  A TD session spreads across several OS windows — the network editor, Perform
 *  windows parked on other displays, the Textport, floating dialogs — and once
 *  two or three projects are open, Alt-Tab is a flat pile of near-identical
 *  entries. These two views cut through that:
 *
 *  - `SessionWindowList` hangs under a Current-tab row: every window of that one
 *    session, with focus/minimize on each.
 *  - `WindowSwitcher` is a search-and-arrow-keys palette over EVERY window of
 *    EVERY open session, grouped by project. Type "perform", hit Enter.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProject, SessionInstance, SessionWindow, WindowAction } from "./types";
import { formatUptime } from "./utils";

/** A window paired with the project it belongs to. */
export interface WindowEntry {
  win: SessionWindow;
  projectPath: string;
  projectName: string;
  /** Index within its own project's window list — 0 is the main window. */
  indexInProject: number;
}

export function collectWindows(projects: OpenProject[]): WindowEntry[] {
  const out: WindowEntry[] = [];
  for (const p of projects) {
    if (!p.alive) continue;
    (p.windows ?? []).forEach((win, i) =>
      out.push({
        win,
        projectPath: p.path,
        projectName: p.display_name || p.path,
        indexInProject: i,
      }),
    );
  }
  return out;
}

/** TD's PaneType enum, in the words a user would use. */
const PANE_KIND: Record<string, string> = {
  NETWORKEDITOR: "Network",
  PANEL: "Panel",
  GEOMETRYVIEWER: "Geometry",
  TOPVIEWER: "TOP",
  CHOPVIEWER: "CHOP",
  ANIMATIONEDITOR: "Animation",
  PARAMETERS: "Parameters",
  TEXTPORT: "Textport",
};

/** Last segment of a network path — "/" is root. */
function ownerName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "root";
  return trimmed.split("/").filter(Boolean).pop() || "root";
}

/** Short role label for a window.
 *
 *  Windows titles a torn-off pane's window with the pane NAME — "pane2",
 *  "copy_of_pane4_0" — which tells you nothing. When the companion Utility has
 *  told us what the pane is showing, use THAT ("Scene · Network"); the OS title
 *  is a meaningless internal id and is not worth showing.
 *
 *  Otherwise fall back to cleaning up the title. TD's main window is titled
 *  "TouchDesigner <build>: <full .toe path>", and the row (or group header)
 *  already names the project — so the path is pure noise. */
/** Label split into the identifying part and the pane kind.
 *
 *  They're separate so a row can truncate the (often long) COMP name while
 *  keeping the kind on screen — two panes onto the same COMP differ only by
 *  kind, so it is the last thing that should be clipped. */
export function windowLabelParts(
  win: SessionWindow,
  projectName: string,
): { primary: string; kind: string } {
  if (win.pane_owner) {
    return {
      primary: ownerName(win.pane_owner),
      kind: win.pane_type ? PANE_KIND[win.pane_type] ?? win.pane_type : "",
    };
  }
  return { primary: windowLabel(win, projectName), kind: "" };
}

export function windowLabel(win: SessionWindow, projectName: string): string {
  if (win.pane_owner) {
    const kind = win.pane_type ? PANE_KIND[win.pane_type] ?? win.pane_type : "";
    const who = ownerName(win.pane_owner);
    return kind ? `${who} · ${kind}` : who;
  }
  const name = projectName.trim();
  // TD titles the main window "TouchDesigner <build>: <path/to/project.toe>".
  // The build string identifies the installation, not the window — the project
  // is what the user is looking for. (Matched on the title rather than assumed
  // from "unowned", so a second top-level window keeps its own name.)
  if (name && win.title.toLowerCase().includes(name.toLowerCase())) {
    return name;
  }
  const stem = name.replace(/\.toe$/i, "");
  let label = win.title.trim();
  label = label.replace(/[A-Za-z]:[\\/]\S*/g, " ").replace(/\S*\.toe\b/gi, " ");
  if (stem) {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    label = label.replace(new RegExp(escaped, "gi"), " ");
  }
  // Collapse the punctuation left behind by the removals.
  label = label.replace(/\s*[-–—:|]\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return label || win.title.trim() || "Untitled window";
}

/** Hover text: the network path a pane shows is the fact worth surfacing;
 *  the raw OS title is kept so the mapping stays inspectable. */
export function windowTooltip(win: SessionWindow): string {
  return win.pane_owner ? `${win.pane_owner}\n(window "${win.title}")` : win.title;
}

/** Secondary line: which display a window lives on — the part that's impossible
 *  to tell from a taskbar entry on a multi-display rig — plus, for a pane, the
 *  full network path it shows (the label only has room for the last segment). */
function placeLabel(win: SessionWindow): string {
  const bits: string[] = [];
  if (win.pane_owner && win.pane_owner !== "/") bits.push(win.pane_owner);
  if (win.monitor > 0) {
    bits.push(`Display ${win.monitor}${win.monitor_primary ? " (main)" : ""}`);
  }
  if (!win.pane_owner && win.width > 0 && win.height > 0) {
    bits.push(`${win.width}×${win.height}`);
  }
  return bits.join(" · ");
}

/** Name that truncates, kind that doesn't. */
function NameParts({ win, projectName }: { win: SessionWindow; projectName: string }) {
  const { primary, kind } = windowLabelParts(win, projectName);
  return (
    <>
      <span className="win-primary">{primary}</span>
      {kind && <span className="win-kind">{kind}</span>}
    </>
  );
}

function StateBadge({ win }: { win: SessionWindow }) {
  if (win.minimized) return <span className="win-badge minimized">minimized</span>;
  if (win.foreground) return <span className="win-badge active">focused</span>;
  // Owned windows are TD's floating panes and dialogs — not top-level.
  if (win.owned) return <span className="win-badge owned">floating</span>;
  return null;
}

/** Windows of one session.
 *
 *  `variant="row"` hangs under a Current-tab row (indented, rule down the
 *  left). `variant="panel"` is the always-visible section in the session detail
 *  pane, with its own heading — and it renders nothing at all when there are no
 *  windows, so it never sits there empty on a platform that can't enumerate
 *  them. */
export function SessionWindowList({
  windows,
  projectName,
  onAction,
  onRaiseAll,
  onMinimizeAll,
  variant = "row",
}: {
  windows: SessionWindow[];
  projectName: string;
  onAction: (win: SessionWindow, action: WindowAction) => void;
  onRaiseAll: () => void;
  onMinimizeAll: () => void;
  variant?: "row" | "panel";
}) {
  if (!windows.length) {
    if (variant === "panel") return null;
    return (
      <div className="win-list empty">
        <span className="hint">No windows reported for this session.</span>
      </div>
    );
  }
  return (
    <div className={`win-list ${variant === "panel" ? "as-panel" : ""}`} onClick={(e) => e.stopPropagation()}>
      {variant === "panel" && (
        <div className="win-list-head">
          Windows<span className="win-count">{windows.length}</span>
        </div>
      )}
      {windows.map((win) => (
        <div
          key={win.id}
          className={["win-row", win.foreground ? "is-foreground" : "", win.minimized ? "is-minimized" : ""]
            .filter(Boolean)
            .join(" ")}
          onDoubleClick={() => onAction(win, "focus")}
          title={windowTooltip(win)}
        >
          <span className="win-name">
            <NameParts win={win} projectName={projectName} />
            <StateBadge win={win} />
          </span>
          <span className="win-place">{placeLabel(win)}</span>
          <span className="win-actions">
            <button className="ghost small" title="Focus this window" onClick={() => onAction(win, "focus")}>
              Focus
            </button>
            <button
              className="ghost small"
              title={win.minimized ? "Restore this window" : "Minimize this window"}
              onClick={() => onAction(win, win.minimized ? "restore" : "minimize")}
            >
              {win.minimized ? "Restore" : "Hide"}
            </button>
          </span>
        </div>
      ))}
      {windows.length > 1 && (
        <div className="win-row bulk">
          <span className="win-name hint">All {windows.length} windows</span>
          <span className="win-actions">
            <button className="ghost small" title="Bring every window of this session forward" onClick={onRaiseAll}>
              Bring all
            </button>
            <button className="ghost small" title="Minimize every window of this session" onClick={onMinimizeAll}>
              Hide all
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Windows of a session that is open more than once, grouped by process.
 *
 *  A project row stays one row — it's one `.toe` — but with two processes on it
 *  the row's PID, perf and Envoy port describe only the primary, and "Focus"
 *  and "Kill" are ambiguous. This breaks the row open so each process is
 *  nameable and killable on its own.
 *
 *  The warning is not decoration: both processes read and write the same
 *  externalized files, so whichever saves last silently wins. */
export function SessionInstanceList({
  instances,
  projectName,
  onAction,
  onRaiseAll,
  onMinimizeAll,
  onFocusInstance,
  onKillInstance,
}: {
  instances: SessionInstance[];
  projectName: string;
  onAction: (win: SessionWindow, action: WindowAction) => void;
  onRaiseAll: (pid: number) => void;
  onMinimizeAll: (pid: number) => void;
  onFocusInstance: (pid: number) => void;
  onKillInstance: (pid: number) => void;
}) {
  return (
    <div className="inst-list" onClick={(e) => e.stopPropagation()}>
      <div className="inst-warn">
        <strong>{projectName}</strong> is open {instances.length} times. Both processes share
        this project&apos;s files — if you save from each, the last save wins.
      </div>
      {instances.map((inst, i) => (
        <div className="inst-group" key={inst.pid}>
          <div className="inst-head">
            <span className="inst-name">
              PID {inst.pid}
              {i === 0 && <span className="inst-badge primary">primary</span>}
              {inst.source === "launcher" ? (
                <span className="inst-badge">started here</span>
              ) : (
                <span className="inst-badge">opened elsewhere</span>
              )}
            </span>
            <span className="inst-place">
              {[
                inst.started_at ? `up ${formatUptime(inst.started_at)}` : null,
                `${inst.windows.length} window${inst.windows.length === 1 ? "" : "s"}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="inst-actions">
              <button
                className="ghost small"
                title={`Focus PID ${inst.pid}`}
                onClick={() => onFocusInstance(inst.pid)}
              >
                Focus
              </button>
              <button
                className="ghost small danger"
                title={`Kill PID ${inst.pid}`}
                onClick={() => onKillInstance(inst.pid)}
              >
                Kill
              </button>
            </span>
          </div>
          <SessionWindowList
            windows={inst.windows}
            projectName={projectName}
            onAction={onAction}
            onRaiseAll={() => onRaiseAll(inst.pid)}
            onMinimizeAll={() => onMinimizeAll(inst.pid)}
          />
        </div>
      ))}
    </div>
  );
}

/** Search palette over every window of every open session. */
export function WindowSwitcher({
  projects,
  onFocus,
  onClose,
}: {
  projects: OpenProject[];
  onFocus: (entry: WindowEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => collectWindows(projects), [projects]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((e) => {
      const hay = [
        e.projectName,
        e.win.title,
        e.win.pane_owner ?? "",
        e.win.pane_type ? PANE_KIND[e.win.pane_type] ?? e.win.pane_type : "",
        `display${e.win.monitor}`,
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [all, query]);

  // A shrinking result set must not leave the cursor past the end.
  useEffect(() => {
    setCursor((c) => (matches.length ? Math.min(c, matches.length - 1) : 0));
  }, [matches.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".switch-row.at-cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setCursor((c) => (matches.length ? (c + 1) % matches.length : 0));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setCursor((c) => (matches.length ? (c - 1 + matches.length) % matches.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[cursor];
      if (hit) onFocus(hit);
    }
  };

  // Project name repeats down the list; show it only when it changes.
  let lastProject = "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide switcher" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="switch-input"
          placeholder="Find a TouchDesigner window…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="switch-list" ref={listRef}>
          {matches.length === 0 && (
            <div className="switch-empty hint">
              {all.length > 0
                ? "No window matches that."
                : projects.some((p) => p.alive)
                  ? "No windows reported for the open sessions — per-window control is Windows-only."
                  : "No TouchDesigner projects are open."}
            </div>
          )}
          {matches.map((entry, i) => {
            const header = entry.projectName !== lastProject ? entry.projectName : null;
            lastProject = entry.projectName;
            return (
              <div key={entry.win.id}>
                {header && <div className="switch-group">{header}</div>}
                <div
                  className={["switch-row", i === cursor ? "at-cursor" : ""].filter(Boolean).join(" ")}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onFocus(entry)}
                  title={windowTooltip(entry.win)}
                >
                  <span className="switch-name">
                    <NameParts win={entry.win} projectName={entry.projectName} />
                    <StateBadge win={entry.win} />
                  </span>
                  <span className="switch-place">{placeLabel(entry.win)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="switch-footer hint">
          ↑↓ move · Enter focus · Esc close — {matches.length} of {all.length} window
          {all.length === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

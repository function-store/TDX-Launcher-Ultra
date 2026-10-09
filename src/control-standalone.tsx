/** Standalone browser/phone build of the control surface, served by the
 * launcher's control server. A touch-first mirror of the desktop Current tab:
 * every session — live or ended (tombstone) — is a tab; the open tab shows
 * that session's facts (version, uptime, PID), the perf readout when the
 * desktop toggle allows it, the session actions (Focus / Save / Thumbnail /
 * Relaunch / Kill, or Relaunch / Dismiss for a tombstone), and the hand-off
 * into that session’s own remote page. Parameter control, touch and the
 * session actions moved into the FNS_Remote package (D5), so this page is the
 * FLEET surface: what only the launcher process can do, plus the links that
 * open each session’s own controls. Destructive actions (Kill, and Relaunch of a
 * live session, which kills first) are hold-to-confirm — the phone analog of
 * the desktop confirm modal. The bearer token arrives in the URL hash
 * (#k=...) so it never appears in server logs or referrers. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProcPerf, TdPerfResult } from "./types";
import { versionNumeric } from "./utils";
import { buildSessionActions, FLEET_SESSION_ACTION_IDS } from "./sessionActions";
import "./App.css";

type Watchdog = {
  active: boolean;
  phase: string;
  last_heartbeat_secs_ago: number | null;
  crash_count: number;
};

type Session = {
  path: string;
  name: string;
  pid: number | null;
  alive: boolean;
  ended_at: number | null;
  started_at: number | null;
  source: string;
  envoy_up: boolean | null;
  version_key: string | null;
  use_touchplayer: boolean;
  utility_available: boolean | null;
  utility_version: string | null;
  watchdog: Watchdog | null;
  /** The hand-off (D5): the session's own FNS_Remote page, its origin and
   *  token. Present only when the package is serving on the LAN. */
  control_url?: string | null;
  client_url?: string | null;
  remote?: {
    state: "off" | "loopback" | "lan";
    paired?: string | null;
    client_touch?: boolean | null;
  } | null;
};

type Recent = {
  path: string;
  name: string;
  source: string | null;
  last_opened: number | null;
};

type AppInfo = {
  ok: boolean;
  name: string;
  theme: string;
  perf_enabled: boolean;
  /** Always "author" since D5 retired the client tier; still on the wire so
   *  a page cached before the rescope parses. */
  role?: string;
};

type PerfPayload = {
  ok: boolean;
  enabled?: boolean;
  proc?: Record<string, ProcPerf>;
  td?: TdPerfResult | null;
};

// App.css styles the desktop as a fixed app window (html/body/#root
// overflow:hidden). This page is a normal scrolling document — flag it so the
// stylesheet can lift that (see "html.standalone" in App.css).
document.documentElement.classList.add("standalone");

// Token lives in the pairing URL's hash (#k=…). Persist it to localStorage so
// a home-screen / PWA launch — which starts at the manifest's bare start_url
// with no hash — still authenticates. Same trust model as a saved bookmark:
// the token is already persisted server-side and shared over the QR; storing
// it on the user's own phone doesn't widen the "same Wi-Fi + has token" gate.
const TOKEN_KEY = "tdxlu-control-token";
const token = (() => {
  const fromHash =
    new URLSearchParams(window.location.hash.replace(/^#/, "")).get("k") ?? "";
  try {
    if (fromHash) {
      window.localStorage.setItem(TOKEN_KEY, fromHash);
      return fromHash;
    }
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return fromHash;
  }
})();

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      msg = j.error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const post = <T,>(path: string, body: unknown) =>
  apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/** "3h 12m" / "12m" / "44s" — coarse on purpose, a glanceable fact. */
function formatSpan(secs: number): string {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/** Same glanceable facts the desktop session pane reports. */
function sessionFacts(s: Session): string[] {
  const facts: string[] = [];
  facts.push(
    s.version_key
      ? versionNumeric(s.version_key) + (s.use_touchplayer ? " (TouchPlayer)" : "")
      : "version unknown",
  );
  if (!s.alive) {
    facts.push(
      s.ended_at
        ? `ended ${formatSpan(Date.now() / 1000 - s.ended_at)} ago`
        : "ended",
    );
    return facts;
  }
  if (s.pid != null) facts.push(`PID ${s.pid}`);
  facts.push(s.source === "launcher" ? "launched here" : "opened externally");
  if (s.started_at) facts.push(`up ${formatSpan(Date.now() / 1000 - s.started_at)}`);
  if (s.utility_available === true) {
    facts.push(`companion${s.utility_version ? ` v${s.utility_version}` : ""}`);
  }
  return facts;
}

/** Heartbeat-watchdog chip for a session, or null when it isn't watched.
 * Mirrors the desktop Heartbeat panel: armed + last pulse, crashes flagged. */
function watchdogFact(s: Session): { text: string; warn: boolean } | null {
  const w = s.watchdog;
  if (!w) return null;
  if (!w.active) {
    return { text: `watchdog ${w.phase || "stopped"}`, warn: w.phase === "gave_up" };
  }
  const pulse =
    w.last_heartbeat_secs_ago != null
      ? `pulse ${formatSpan(w.last_heartbeat_secs_ago)} ago`
      : "no pulse yet";
  const crashes = w.crash_count > 0 ? ` · ${w.crash_count} restart${w.crash_count > 1 ? "s" : ""}` : "";
  // Amber when a pulse is overdue (>15s) or the watchdog has had to restart.
  const stale = (w.last_heartbeat_secs_ago ?? 0) > 15;
  return { text: `♥ armed · ${pulse}${crashes}`, warn: stale || w.crash_count > 0 };
}

/** Perf line parts; TD numbers come from the companion's Perform CHOP. */
function perfParts(
  proc: ProcPerf | null,
  td: TdPerfResult | null,
): { text: string; warn?: boolean }[] {
  const parts: { text: string; warn?: boolean }[] = [];
  if (td?.fps != null) parts.push({ text: `${td.fps.toFixed(1)} fps` });
  if (td?.cook_ms != null) parts.push({ text: `cook ${td.cook_ms.toFixed(1)} ms` });
  if (td?.dropped != null && td.dropped > 0) {
    parts.push({ text: `drops ${Math.round(td.dropped)}`, warn: true });
  }
  if (td?.gpu_mem_mb != null) {
    const total = td.gpu_mem_total_mb ? `/${Math.round(td.gpu_mem_total_mb)}` : "";
    parts.push({ text: `GPU ${Math.round(td.gpu_mem_mb)}${total} MB` });
  }
  if (proc) {
    parts.push({ text: `CPU ${proc.cpu_pct.toFixed(0)}%` });
    parts.push({
      text:
        proc.mem_mb >= 1024
          ? `RAM ${(proc.mem_mb / 1024).toFixed(1)} GB`
          : `RAM ${proc.mem_mb} MB`,
    });
  }
  return parts;
}

/** Fire a haptic buzz where the device supports it — no-op otherwise. */
function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

/** A button that fires only after a press-and-hold — the touch analog of a
 *  confirm dialog. Holding fills a bar; releasing early cancels. A short tick
 *  marks the start of the hold and a firmer double-buzz confirms the action,
 *  so the commit is felt as well as seen. */
function HoldButton({
  label,
  holdLabel,
  onConfirm,
  className,
  disabled,
}: {
  label: string;
  holdLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const HOLD_MS = 700;
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setHolding(false);
  }, []);

  const start = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      setHolding(true);
      buzz(10); // tick: the hold has begun
      timer.current = window.setTimeout(() => {
        setHolding(false);
        timer.current = null;
        buzz([25, 40, 25]); // firmer: the action just fired
        onConfirm();
      }, HOLD_MS);
    },
    [disabled, onConfirm],
  );

  return (
    <button
      type="button"
      className={`hold-btn ${className ?? ""} ${holding ? "holding" : ""}`}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      style={holding ? { ["--hold-ms" as string]: `${HOLD_MS}ms` } : undefined}
    >
      <span className="hold-fill" />
      <span className="hold-label">{holding ? holdLabel : label}</span>
    </button>
  );
}

const PERF_POLL_MS = 4000;
const TOAST_MS = 4000;

function StandaloneApp() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [showLaunch, setShowLaunch] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [perfEnabled, setPerfEnabled] = useState(false);
  const [perf, setPerf] = useState<{ proc: ProcPerf | null; td: TdPerfResult | null }>({
    proc: null,
    td: null,
  });
  const toastTimer = useRef<number | null>(null);

  // Keep the screen awake — a control surface that sleeps mid-show is useless.
  // The lock drops when the tab is hidden (OS policy), so re-acquire whenever
  // the page becomes visible again. Silent no-op where the API is absent.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let released = false;
    const wl = (navigator as { wakeLock?: { request: (t: "screen") => Promise<typeof lock> } })
      .wakeLock;
    if (!wl) return;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      wl.request("screen")
        .then((l) => {
          if (released) void l?.release();
          else lock = l;
        })
        .catch(() => {
          /* denied (low battery, unsupported) — nothing to do */
        });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, []);

  // Toasts auto-clear; errors linger a little longer than confirmations
  // would but still leave the screen — a stale "Save ✓" reads as fresh truth.
  const toast = useCallback((msg: string) => {
    setStatus(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setStatus(""), TOAST_MS);
  }, []);

  // App info once: theme (the phone matches the desktop) + perf toggle.
  useEffect(() => {
    apiFetch<AppInfo>("/api/app")
      .then((info) => {
        document.documentElement.dataset.theme = info.theme;
        setPerfEnabled(info.perf_enabled);
      })
      .catch(() => {
        /* older server: keep defaults */
      });
  }, []);

  const applyList = useCallback((r: { sessions: Session[] }) => {
    setListError(null);
    setSessions(r.sessions);
    setSelected((cur) => {
      // Keep the open tab even if its session just ended — the user should
      // see the tombstone state, not be teleported to another project.
      if (cur && r.sessions.some((s) => s.path === cur)) return cur;
      const live = r.sessions.filter((s) => s.alive);
      return (
        live.find((s) => s.utility_available)?.path ??
        live[0]?.path ??
        r.sessions[0]?.path ??
        null
      );
    });
  }, []);

  const refreshRecents = useCallback(() => {
    apiFetch<{ recents: Recent[] }>("/api/recents")
      .then((r) => setRecents(r.recents))
      .catch(() => {
        /* older server without /api/recents — hide the launch section */
      });
  }, []);

  const refresh = useCallback(() => {
    apiFetch<{ sessions: Session[] }>("/api/sessions")
      .then(applyList)
      .catch((e) => setListError(String(e)));
    refreshRecents();
  }, [applyList, refreshRecents]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const sel = sessions.find((s) => s.path === selected) ?? null;

  // Perf poll for the open tab while it's live and the desktop toggle is on.
  const selPath = sel?.alive ? sel.path : null;
  const selUtil = sel?.utility_available === true;
  const selPid = sel?.pid ?? null;
  useEffect(() => {
    if (!perfEnabled || !selPath) {
      setPerf({ proc: null, td: null });
      return;
    }
    let gone = false;
    const tick = () => {
      const q = selUtil ? `?td=${encodeURIComponent(selPath)}` : "";
      apiFetch<PerfPayload>(`/api/sessions/perf${q}`)
        .then((r) => {
          if (gone) return;
          if (!r.ok || r.enabled === false) {
            setPerfEnabled(r.enabled !== false);
            return;
          }
          setPerf({
            proc: (selPid != null && r.proc?.[String(selPid)]) || null,
            td: r.td && r.td.ok !== false ? r.td : null,
          });
        })
        .catch(() => {
          /* transient — next tick retries */
        });
    };
    tick();
    const id = window.setInterval(tick, PERF_POLL_MS);
    return () => {
      gone = true;
      window.clearInterval(id);
    };
  }, [perfEnabled, selPath, selUtil, selPid]);

  const act = useCallback(
    async (key: string, label: string, run: () => Promise<{ sessions: Session[] }>) => {
      setBusy(key);
      toast(`${label}…`);
      try {
        applyList(await run());
        toast(`${label} ✓`);
      } catch (e) {
        toast(`${label} failed: ${e}`);
      } finally {
        setBusy(null);
      }
    },
    [applyList, toast],
  );

  const focus = (s: Session) =>
    s.pid != null &&
    void post("/api/sessions/focus", { pid: s.pid })
      .then(() => toast("Focused on host"))
      .catch((e) => toast(String(e)));

  const relaunch = (s: Session, killFirst: boolean) =>
    void act(`relaunch:${s.path}`, "Relaunch", () =>
      post("/api/sessions/relaunch", {
        path: s.path,
        version_key: s.version_key,
        use_touchplayer: s.use_touchplayer,
        kill_first: killFirst,
        pid: s.pid,
      }),
    );

  const kill = (s: Session) =>
    s.pid != null &&
    void act(`kill:${s.path}`, "Kill", () => post("/api/sessions/kill", { pid: s.pid }));

  const dismiss = (s: Session) =>
    void act(`dismiss:${s.path}`, "Dismiss", () =>
      post("/api/sessions/dismiss", { path: s.path }),
    );

  const launch = async (r: Recent) => {
    setShowLaunch(false);
    await act(`launch:${r.path}`, "Launch", () =>
      post("/api/launch", { path: r.path }),
    );
    // Land on the freshly-launched session's tab. Set AFTER the launch lands so
    // a background refresh mid-launch (session not yet registered) can't leave
    // the fallback selection sticking to another session.
    setSelected(r.path);
  };

  const facts = sel ? sessionFacts(sel) : [];
  const watchdog = sel?.alive ? watchdogFact(sel) : null;
  const perfLine = sel?.alive ? perfParts(perf.proc, perf.td) : [];
  const canUtil = sel?.alive === true && sel.utility_available === true;
  const phoneActions = sel
    ? buildSessionActions({
        alive: sel.alive,
        hasPid: sel.pid != null,
        hasCompanion: canUtil,
        hasEnvoy: false,
        windowCount: 0,
      }).filter((a) => FLEET_SESSION_ACTION_IDS.has(a.id))
    : [];

  return (
    <div className="control-standalone phone">
      <header className="phone-chrome">
        <div className="control-standalone-bar">
          <strong>TDXLU Remote</strong>
          <span className="phone-conn" data-ok={!listError}>
            {listError ? "offline" : "live"}
          </span>
          {recents.length > 0 && (
            <button
              type="button"
              className={`small ghost ${showLaunch ? "tags-toggle-on" : ""}`}
              onClick={() => setShowLaunch((v) => !v)}
            >
              + Launch
            </button>
          )}
          <button type="button" className="small ghost" onClick={refresh}>
            Refresh
          </button>
        </div>

        {sessions.length > 0 && (
          <nav className="phone-tabs" aria-label="Sessions">
            {sessions.map((s) => (
              <button
                key={s.path}
                type="button"
                className={`phone-tab ${s.path === selected ? "active" : ""} ${
                  s.alive ? "" : "stale"
                }`}
                onClick={() => setSelected(s.path)}
              >
                <span className={`phone-dot ${s.alive ? (s.utility_available ? "util" : "live") : "ended"}`} />
                {s.name || basename(s.path)}
              </button>
            ))}
          </nav>
        )}
      </header>

      {listError && (
        <div className="phone-banner">
          {token
            ? `Launcher unreachable: ${listError}`
            : "Missing token — open this page from the TDXLU Control panel's Phone button."}
        </div>
      )}

      {showLaunch && (
        <section className="phone-launch">
          <div className="phone-launch-title">Launch a project</div>
          {recents.length === 0 ? (
            <div className="tag-hint">No recent projects to launch.</div>
          ) : (
            recents.map((r) => (
              <button
                key={r.path}
                type="button"
                className="phone-launch-row"
                disabled={!!busy}
                onClick={() => launch(r)}
              >
                <span className="phone-launch-name">{r.name}</span>
                <span className="phone-launch-open">Open ▸</span>
              </button>
            ))
          )}
        </section>
      )}

      {sessions.length === 0 && !listError && !showLaunch && (
        <div className="phone-empty">
          No TouchDesigner sessions.
          <div className="tag-hint">
            {recents.length > 0
              ? "Tap + Launch to open a project, or start one from the desktop."
              : "Sessions you launch (or that end) appear here as tabs."}
          </div>
        </div>
      )}

      {sel && (
        <section className={`phone-detail ${sel.alive ? "" : "stale"}`}>
          <div className="phone-detail-head">
            <span className="phone-session-name">{sel.name || basename(sel.path)}</span>
            <span className="phone-session-tag">{sel.alive ? "running" : "ended"}</span>
          </div>
          <div className="phone-facts">
            {facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
          <div className="phone-path">{sel.path}</div>
          {watchdog && (
            <div className="phone-facts phone-watchdog">
              <span className={watchdog.warn ? "warn" : ""}>{watchdog.text}</span>
            </div>
          )}
          {perfEnabled && perfLine.length > 0 && (
            <div className="phone-facts phone-perf">
              {perfLine.map((p) => (
                <span key={p.text} className={p.warn ? "warn" : ""}>
                  {p.text}
                </span>
              ))}
            </div>
          )}

          <div className="phone-session-actions">
            {phoneActions.map((action) => {
              if (action.id === "relaunch" && sel.alive) {
                return (
                  <HoldButton
                    key={action.id}
                    className="pbtn"
                    label="Relaunch"
                    holdLabel="Hold to restart…"
                    disabled={!!busy}
                    onConfirm={() => relaunch(sel, true)}
                  />
                );
              }
              if (action.id === "kill") {
                return (
                  <HoldButton
                    key={action.id}
                    className="pbtn danger"
                    label={action.label}
                    holdLabel="Hold to kill…"
                    disabled={!!busy || !action.enabled}
                    onConfirm={() => kill(sel)}
                  />
                );
              }
              const run = () => {
                if (action.id === "focus") focus(sel);
                else if (action.id === "relaunch") relaunch(sel, false);
                else if (action.id === "dismiss") dismiss(sel);
              };
              return (
                <button
                  key={action.id}
                  className={`pbtn${action.id === "relaunch" ? " primary" : ""}`}
                  disabled={!!busy || !action.enabled}
                  onClick={run}
                >
                  {action.label}
                </button>
              );
            })}
          </div>

          {sel.alive && sel.remote && (
            <div className="phone-facts phone-handoff">
              {sel.remote.state === "lan" && sel.control_url ? (
                <>
                  <span>remote served by the session</span>
                  <button
                    type="button"
                    className="pbtn primary"
                    onClick={() => window.open(sel.control_url ?? "", "_blank", "noopener")}
                  >
                    Open remote ▸
                  </button>
                  {sel.client_url && (
                    <button
                      type="button"
                      className="pbtn"
                      title="The reduced page: exposed controls only, no actions"
                      onClick={() => window.open(sel.client_url ?? "", "_blank", "noopener")}
                    >
                      Client link ▸
                    </button>
                  )}
                </>
              ) : sel.remote.state === "loopback" ? (
                <span className="warn">
                  remote is serving on this machine only — turn on LAN in FNS_Remote (Phone
                  Remote… in TouchDesigner)
                </span>
              ) : (
                <span>FNS_Remote is in this session but not serving</span>
              )}
            </div>
          )}

          {sel.alive && !sel.remote && (
            <div className="phone-params tag-hint">
              Parameter control, touch and save / snapshot / record live in the
              FNS_Remote package now. Install it into this session from the
              FNSTools tab, then this session serves its own link here.
            </div>
          )}
        </section>
      )}

      {status && (
        <div className="phone-toast" onClick={() => setStatus("")}>
          {status}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StandaloneApp />);

import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { WatchOverview, WatchSessionStatus } from "./types";

type Props = {
  projectPath: string | null;
  versionKey: string | null;
  usePlayer: boolean;
  canUse: boolean;
  tcpPort: number;
  onStatusMsg: (msg: string) => void;
  /** Open Settings on a named section (a `data-settings-section` id in App.tsx). */
  onOpenSettings: (section?: string) => void;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export default function WatchPanel({
  projectPath,
  versionKey,
  usePlayer,
  canUse,
  tcpPort,
  onStatusMsg,
  onOpenSettings,
}: Props) {
  const [overview, setOverview] = useState<WatchOverview | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setOverview(await api.watchStatus());
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    let un: (() => void) | undefined;
    void listen<WatchOverview>("watch-status", (e) => {
      setOverview(e.payload);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectPath) {
      setProjectId("");
      return;
    }
    let cancelled = false;
    void api.watchProjectId(projectPath).then((id) => {
      if (!cancelled) setProjectId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const sessions = overview?.sessions ?? [];
  const selectedWatching = useMemo(
    () => (projectId ? sessions.find((s) => s.id === projectId) : undefined),
    [sessions, projectId],
  );

  const focused: WatchSessionStatus | undefined =
    (focusId && sessions.find((s) => s.id === focusId)) ||
    selectedWatching ||
    sessions[0];

  useEffect(() => {
    if (focusId && !sessions.some((s) => s.id === focusId)) {
      setFocusId(null);
    }
  }, [sessions, focusId]);

  const start = async () => {
    if (!projectPath || !versionKey || !canUse) return;
    setBusy(true);
    try {
      const st = await api.watchStart(projectPath, versionKey, usePlayer);
      setOverview(st);
      if (projectId) setFocusId(projectId);
      onStatusMsg(`Watching ${basename(projectPath)} · port ${st.port}`);
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopOne = async (id: string) => {
    setBusy(true);
    try {
      const st = await api.watchStop(id);
      setOverview(st);
      onStatusMsg("Watch stopped");
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    setBusy(true);
    try {
      const st = await api.watchStopAll();
      setOverview(st);
      onStatusMsg("All watches stopped");
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyId = async () => {
    if (!projectId) return;
    try {
      await navigator.clipboard.writeText(projectId);
      onStatusMsg("Project id copied");
    } catch {
      onStatusMsg(projectId);
    }
  };

  const hb = (s: WatchSessionStatus | undefined) =>
    s?.last_heartbeat_secs_ago != null
      ? `${s.last_heartbeat_secs_ago.toFixed(1)}s ago`
      : "none";

  return (
    <div className="right-col watch-side">
      <div className="readme-header git-side-header">
        <strong>Heartbeat</strong>
        <span className="git-summary-chip">{overview?.message ?? "—"}</span>
        <button type="button" className="small ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="backup-roots">
        <div className="tag-hint">
          Multi-project: one TCP port (<code>127.0.0.1:{tcpPort}</code>), each{" "}
          <code>.toe</code> has its own id. Heartbeats must include that id.
        </div>
        {projectPath && projectId && (
          <div className="watch-id-row">
            <code className="watch-id" title={projectId}>
              {projectId}
            </code>
            <button type="button" className="small ghost" onClick={() => void copyId()}>
              Copy id
            </button>
          </div>
        )}
      </div>

      <div className="backup-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !canUse || !projectPath || !versionKey || !!selectedWatching}
          onClick={() => void start()}
        >
          {selectedWatching ? "Already watching" : "Start & launch"}
        </button>
        {selectedWatching && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => void stopOne(selectedWatching.id)}
          >
            Stop selected
          </button>
        )}
        {sessions.length > 0 && (
          <button type="button" className="small" disabled={busy} onClick={() => void stopAll()}>
            Stop all
          </button>
        )}
        <button type="button" className="small ghost" onClick={() => onOpenSettings("heartbeat")}>
          Settings…
        </button>
      </div>

      {!canUse && (
        <div className="git-side-empty subtle">Select a project (with a TD version) to watch</div>
      )}

      {sessions.length > 0 && (
        <div className="watch-sessions">
          <div className="git-changes-head">
            <span>Sessions ({sessions.length})</span>
            {overview?.listening ? (
              <span className="tag-hint">listening :{overview.port}</span>
            ) : null}
          </div>
          <ul className="watch-session-list">
            {sessions.map((s) => {
              const active = focusId === s.id || (!focusId && focused?.id === s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`watch-session-btn${active ? " active" : ""}`}
                    onClick={() => setFocusId(s.id)}
                  >
                    <span className="watch-session-name">{basename(s.project_path)}</span>
                    <span className="watch-session-meta">
                      {s.phase}
                      {s.fps != null ? ` · ${s.fps.toFixed(0)}fps` : ""}
                      {` · hb ${hb(s)}`}
                      {s.crash_count ? ` · ×${s.crash_count}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="small ghost"
                    disabled={busy}
                    onClick={() => void stopOne(s.id)}
                    title="Stop this watch"
                  >
                    Stop
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="watch-log">
        <div className="git-changes-head">
          <span>Log{focused ? ` · ${basename(focused.project_path)}` : ""}</span>
        </div>
        <pre className="watch-log-pre">
          {(focused?.log_lines ?? []).length
            ? focused!.log_lines.join("\n")
            : "No watch events yet."}
        </pre>
      </div>

      <div className="backup-footnote tag-hint">
        Companion must send <code>id</code> / <code>path</code> matching the project id above. See{" "}
        <code>utility/heartbeat/PROTOCOL.md</code>. Logs:{" "}
        <code>%APPDATA%\TDXLU\watch_logs\</code>
      </div>
    </div>
  );
}

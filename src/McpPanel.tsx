import { useEffect, useState } from "react";
import { api } from "./api";
import type { McpBridgeStatus } from "./types";

type Props = {
  projectPath: string | null;
  versionKey: string | null;
  usePlayer: boolean;
  canUse: boolean;
  onStatusMsg: (msg: string) => void;
  onLaunchToe: (toePath: string) => void;
};

function statusKind(st: McpBridgeStatus | null): "online" | "partial" | "offline" | "none" {
  if (!st || !st.detected) return "none";
  if (st.status === "online" || st.envoy_reachable) return "online";
  if (st.status === "td_up_envoy_down" || st.td_alive) return "partial";
  return "offline";
}

function statusLabel(st: McpBridgeStatus | null): string {
  switch (statusKind(st)) {
    case "online":
      return "ONLINE";
    case "partial":
      return "PARTIAL";
    case "offline":
      return "OFFLINE";
    default:
      return "NO MCP";
  }
}

function statusDetail(st: McpBridgeStatus | null): string {
  if (!st) return "Select a project";
  if (!st.detected) return st.message || "No .embody / .mcp.json found";
  if (st.status === "online") {
    return st.port != null ? `Envoy reachable on :${st.port}` : st.message;
  }
  if (st.status === "td_up_envoy_down") {
    return "TD running — Envoy not responding";
  }
  return st.message || "Envoy offline";
}

export default function McpPanel({
  projectPath,
  versionKey,
  usePlayer,
  canUse,
  onStatusMsg,
  onLaunchToe,
}: Props) {
  const [st, setSt] = useState<McpBridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState("");

  const refresh = async () => {
    if (!projectPath) {
      setSt(null);
      return;
    }
    try {
      const next = await api.mcpStatus(projectPath);
      setSt((prev) => {
        setPortDraft((draft) => {
          if (!draft) return next.port != null ? String(next.port) : "";
          if (prev?.port != null && draft === String(prev.port) && next.port != null) {
            return String(next.port);
          }
          return draft;
        });
        return next;
      });
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  useEffect(() => {
    setPortDraft("");
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const copySnippet = async () => {
    const text = st?.mcp_snippet;
    if (!text) {
      onStatusMsg("No .mcp.json snippet");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      onStatusMsg("MCP snippet copied");
    } catch {
      onStatusMsg("Clipboard failed");
    }
  };

  const openFolder = async () => {
    if (!projectPath) return;
    setBusy(true);
    try {
      await api.mcpOpenFolder(projectPath);
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyPort = async () => {
    if (!projectPath) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      onStatusMsg("Port must be an integer 1024-65535");
      return;
    }
    setBusy(true);
    try {
      const next = await api.mcpSetPort(projectPath, port);
      setSt(next);
      setPortDraft(String(port));
      onStatusMsg(next.message);
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const launchTd = () => {
    const toe = st?.toe_path || projectPath;
    if (!toe || !versionKey) {
      onStatusMsg("Need a .toe and TD version to launch");
      return;
    }
    onLaunchToe(toe);
    onStatusMsg(`Launching ${toe.split(/[/\\]/).pop()}…`);
    window.setTimeout(() => void refresh(), 2500);
  };

  const kind = statusKind(canUse ? st : null);
  const portDirty =
    st?.port != null && portDraft !== "" && Number(portDraft) !== st.port;

  const openLink = (url: string) => {
    void api.openUrl(url).catch((e) => onStatusMsg(String(e)));
  };

  return (
    <div className="right-col watch-side mcp-side">
      <div className="readme-header git-side-header">
        <strong>Envoy MCP</strong>
        <button type="button" className="small ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="mcp-side-body">
        <div className={`mcp-status-banner mcp-status-${kind}`} role="status">
          <span className="mcp-status-dot" aria-hidden />
          <div className="mcp-status-text">
            <div className="mcp-status-label">{statusLabel(canUse ? st : null)}</div>
            <div className="mcp-status-detail">{statusDetail(canUse ? st : null)}</div>
          </div>
          {st?.port != null && <div className="mcp-status-port">:{st.port}</div>}
        </div>

        <div className="backup-roots mcp-about">
          <div className="tag-hint">
            This tab manages the <strong>Embody / Envoy</strong> AI bridge for a project — it does
            not host MCP tools itself. Drop Embody into a <code>.toe</code>, enable Envoy, then
            point Cursor/Claude at the project <code>.mcp.json</code>.
          </div>
          <div className="mcp-link-row">
            <button
              type="button"
              className="small ghost"
              onClick={() => openLink("https://github.com/dylanroscover/Embody")}
              title="Embody on GitHub — TD externalization + Envoy MCP"
            >
              Embody on GitHub
            </button>
            <button
              type="button"
              className="small ghost"
              onClick={() => openLink("https://github.com/dylanroscover/Embody#envoy-mcp-server")}
              title="Envoy MCP setup in the Embody README"
            >
              Envoy setup
            </button>
            <button
              type="button"
              className="small ghost"
              onClick={() => openLink("https://modelcontextprotocol.io/")}
              title="What is the Model Context Protocol?"
            >
              What is MCP?
            </button>
          </div>
        </div>

        {!canUse && (
          <div className="git-side-empty subtle">Select a project to inspect MCP config</div>
        )}

        {canUse && st && !st.detected && (
          <div className="backup-roots">
            <div className="git-side-empty subtle">{st.message}</div>
            <div className="tag-hint">
              New here? Install Embody in TouchDesigner, open this project as the AI workspace
              root, enable Envoy, then Refresh. See{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => openLink("https://github.com/dylanroscover/Embody")}
              >
                dylanroscover/Embody
              </button>
              .
            </div>
          </div>
        )}

        {canUse && st?.detected && (
          <>
            <div className="backup-roots mcp-port-row">
              <label className="mcp-port-label" htmlFor="mcp-port-input">
                Envoy port
              </label>
              <input
                id="mcp-port-input"
                className="mcp-port-input"
                type="number"
                min={1024}
                max={65535}
                step={1}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void applyPort();
                }}
              />
              <button
                type="button"
                className="small"
                disabled={busy || !portDirty}
                onClick={() => void applyPort()}
                title="Write port to .embody/envoy.json, config.json, and .mcp.json"
              >
                Apply
              </button>
            </div>

            <div className="backup-roots mcp-meta">
              <div>
                <span className="tag-hint">Provider</span>{" "}
                <strong>{st.provider_label || st.provider_id}</strong>
                {st.active_instance ? (
                  <span className="tag-hint"> · {st.active_instance}</span>
                ) : null}
              </div>
              <div className="tag-hint" title={st.project_root || undefined}>
                Root: <code>{st.project_root}</code>
              </div>
              {st.toe_path && (
                <div className="tag-hint" title={st.toe_path}>
                  Toe: <code>{st.toe_path}</code>
                </div>
              )}
              {st.td_pid != null && (
                <div className="tag-hint">
                  TD pid {st.td_pid}
                  {st.td_alive ? " (alive)" : " (not running)"}
                </div>
              )}
              {st.mcp_server_keys.length > 0 && (
                <div className="tag-hint">
                  mcpServers:{" "}
                  {st.mcp_server_keys.map((k) => (
                    <code key={k}>{k}</code>
                  ))}
                </div>
              )}
            </div>

            <div className="backup-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || !versionKey}
                onClick={launchTd}
                title={usePlayer ? "Launch with TouchPlayer" : "Launch TouchDesigner"}
              >
                {st.envoy_reachable ? "Relaunch TD" : "Launch TD + Envoy"}
              </button>
              <button
                type="button"
                className="small"
                disabled={busy || !st.mcp_snippet}
                onClick={() => void copySnippet()}
              >
                Copy .mcp.json
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={busy}
                onClick={() => void openFolder()}
              >
                Open folder
              </button>
            </div>

            {st.bridge_command && (
              <div className="mcp-bridge-cmd">
                <div className="git-changes-head">
                  <span>Bridge command (from .mcp.json)</span>
                </div>
                <pre className="mcp-bridge-cmd-pre">{st.bridge_command}</pre>
              </div>
            )}
          </>
        )}
      </div>

      <div className="backup-footnote tag-hint mcp-footnote">
        Port Apply writes disk config; the Utility Envoy page syncs{" "}
        <code>op.Embody.par.Envoyport</code> while TD is open. Restart the AI MCP client after
        changing ports.
      </div>
    </div>
  );
}

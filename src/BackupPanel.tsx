import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { endOp, startOp, withOp } from "./ops";
import type { MenuEntry } from "./ContextMenu";
import { formatBytes, numberWildcardName } from "./utils";
import { loadFileSort, saveFileSort, type FileSort } from "./uiPersist";
import type {
  BackupFileOp,
  BackupPlan,
  BackupTargetInfo,
  RcloneStatus,
} from "./types";

type Props = {
  projectPath: string | null;
  canUse: boolean;
  /** Optional label when backing up a palette folder rather than a .toe project. */
  contextLabel?: string | null;
  backupRoot: string;
  /** Base folder on cloud remotes (Settings); empty = top of the remote. */
  cloudBackupRoot: string;
  onStatusMsg: (msg: string) => void;
  /** Open Settings on a named section (a `data-settings-section` id in App.tsx). */
  onOpenSettings: (section?: string) => void;
  onBackupRootChange: (root: string) => void;
  /** Current exclude filters (Settings text, one glob per line) — for dedupe. */
  excludeGlobs: string;
  /** Append a glob to the exclude filters; resolves false when already present. */
  onAddExclude: (pattern: string) => Promise<boolean>;
  /** Open the app context menu (right-click on plan rows). */
  onOpenMenu?: (e: React.MouseEvent, entries: MenuEntry[]) => void;
  /** Also skip files the project's .gitignore matches (repos only). */
  respectGitignore: boolean;
  onRespectGitignoreChange: (on: boolean) => void;
};

/** "folder" or the name of an rclone cloud remote. */
const DEST_KEY = "tdxlu.backup.dest";

const CLOUD_PROVIDERS: { type: string; label: string; defaultName: string }[] = [
  { type: "drive", label: "Google Drive", defaultName: "gdrive" },
  { type: "dropbox", label: "Dropbox", defaultName: "dropbox" },
  { type: "onedrive", label: "OneDrive", defaultName: "onedrive" },
  { type: "box", label: "Box", defaultName: "box" },
];

function loadDest(): string {
  try {
    return localStorage.getItem(DEST_KEY) || "folder";
  } catch {
    return "folder";
  }
}

function saveDest(dest: string) {
  try {
    localStorage.setItem(DEST_KEY, dest);
  } catch {
    /* ignore */
  }
}

/** Name of the folder the project lives in (a .toe's parent, or the folder itself). */
function projectFolderName(projectPath: string | null): string {
  if (!projectPath) return "project";
  const segs = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (/\.[a-z0-9]{1,5}$/i.test(last)) return segs[segs.length - 2] ?? "project";
  return last || "project";
}

function OpRow({
  op,
  onContextMenu,
}: {
  op: BackupFileOp;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const arrow =
    op.direction === "to_remote"
      ? "↑"
      : op.direction === "to_local"
        ? "↓"
        : op.direction === "filtered"
          ? "✕"
          : "·";
  return (
    <div className={`backup-op-row dir-${op.direction}`} onContextMenu={onContextMenu}>
      <span className="backup-op-arrow">{arrow}</span>
      <span className="backup-op-path" title={op.relative}>
        {op.relative}
      </span>
      {op.bytes > 0 && <span className="backup-op-size">{formatBytes(op.bytes)}</span>}
      <span className="backup-op-reason">{op.reason}</span>
    </div>
  );
}

export default function BackupPanel({
  projectPath,
  canUse,
  contextLabel,
  backupRoot,
  cloudBackupRoot,
  onStatusMsg,
  onOpenSettings,
  onBackupRootChange,
  excludeGlobs,
  onAddExclude,
  onOpenMenu,
  respectGitignore,
  onRespectGitignoreChange,
}: Props) {
  const [info, setInfo] = useState<BackupTargetInfo | null>(null);
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [remoteOverride, setRemoteOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"backup" | "restore" | "sync">("backup");
  const [showFiltered, setShowFiltered] = useState(false);
  const [sort, setSort] = useState<FileSort>(() => loadFileSort("backupPlan"));

  const pickSort = (s: FileSort) => {
    setSort(s);
    saveFileSort("backupPlan", s);
  };

  const [dest, setDest] = useState<string>(loadDest);
  const [rc, setRc] = useState<RcloneStatus | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [cloudMsg, setCloudMsg] = useState("");

  const cloudDest = dest !== "folder";
  const cloudRemote = cloudDest ? dest : null;
  const effectiveMode = cloudDest && mode === "sync" ? "backup" : mode;
  const refreshSeq = useRef(0);

  const pickDest = (d: string) => {
    setDest(d);
    saveDest(d);
    setRemoteOverride("");
    setInfo(null);
    setPlan(null);
  };

  const refreshRclone = async () => {
    try {
      const s = await api.rcloneStatus();
      setRc(s);
      return s;
    } catch (e) {
      onStatusMsg(String(e));
      return null;
    }
  };

  useEffect(() => {
    void refreshRclone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A persisted cloud destination whose remote is gone falls back to folder.
  useEffect(() => {
    if (rc && cloudRemote && !rc.remotes.some((r) => r.name === cloudRemote)) {
      pickDest("folder");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rc]);

  const refresh = async () => {
    if (!projectPath || !canUse) {
      setInfo(null);
      setPlan(null);
      return;
    }
    if (!cloudDest && !backupRoot.trim() && !remoteOverride.trim()) {
      setInfo(null);
      setPlan(null);
      return;
    }
    const seq = ++refreshSeq.current;
    try {
      const override = remoteOverride.trim() || null;
      if (cloudRemote) {
        setBusy(true);
        startOp("backup-plan", `☁ ${cloudRemote} — checking…`);
        const t = await api.cloudBackupInfo(projectPath, cloudRemote, override);
        if (seq !== refreshSeq.current) return;
        setInfo(t);
        const p = await api.cloudBackupPlan(
          projectPath,
          cloudRemote,
          effectiveMode,
          override,
        );
        if (seq !== refreshSeq.current) return;
        setPlan(p);
      } else {
        const t = await api.backupTargetInfo(projectPath, override);
        if (seq !== refreshSeq.current) return;
        setInfo(t);
        const p = await api.backupPlan(projectPath, effectiveMode, override);
        if (seq !== refreshSeq.current) return;
        setPlan(p);
      }
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setInfo(null);
      setPlan(null);
      onStatusMsg(String(e));
    } finally {
      if (seq === refreshSeq.current) {
        setBusy(false);
        endOp("backup-plan");
      }
    }
  };

  useEffect(() => {
    // Cloud lookups hit the network — debounce while the user types a path.
    if (cloudDest) {
      const t = setTimeout(() => void refresh(), 500);
      return () => clearTimeout(t);
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, canUse, backupRoot, cloudBackupRoot, remoteOverride, mode, dest, respectGitignore]);

  const run = async (runMode: "backup" | "restore" | "sync") => {
    if (!projectPath || !canUse) return;
    setBusy(true);
    setMode(runMode);
    try {
      const override = remoteOverride.trim() || null;
      const destLabel = cloudRemote ? `☁ ${cloudRemote}` : "folder";
      const opLabel =
        runMode === "restore"
          ? `Restore ← ${destLabel}`
          : runMode === "sync"
            ? "Sync ⇄ folder"
            : `Backup → ${destLabel}`;
      // "backup" matches the backend transfer-progress op_id, so the chip
      // shows live per-file / byte progress.
      const result = await withOp("backup", opLabel, () =>
        cloudRemote
          ? api.cloudBackupRun(projectPath, cloudRemote, runMode, override)
          : api.backupRun(projectPath, runMode, override),
      );
      onStatusMsg(result.summary);
      if (result.errors.length) {
        onStatusMsg(`${result.summary} — ${result.errors[0]}`);
      }
      await refresh();
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  // --- "Exclude…" context menu on plan rows --------------------------------

  /** Filter lines already configured, normalized for a duplicate check. */
  const excludedLines = new Set(
    excludeGlobs
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\\/g, "/").toLowerCase())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("//")),
  );

  const addExclude = async (pattern: string) => {
    try {
      const added = await onAddExclude(pattern);
      onStatusMsg(added ? `Excluded ${pattern}` : `Already excluded: ${pattern}`);
      if (added) await refresh();
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  const addGitignore = async (pattern: string) => {
    if (!projectPath) return;
    try {
      const added = await api.gitIgnoreAdd(projectPath, pattern);
      onStatusMsg(
        added ? `Added to .gitignore: ${pattern}` : `Already in .gitignore: ${pattern}`,
      );
      if (added && respectGitignore) await refresh();
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  /**
   * The same smart suggestions re-anchored to .gitignore syntax (leading "/"
   * pins to the repo root, trailing "/" matches folders).
   */
  const gitignoreEntries = (op: BackupFileOp): MenuEntry[] => {
    const rel = op.relative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const segs = rel.split("/").filter(Boolean);
    const name = segs[segs.length - 1] ?? rel;
    const dir = segs.slice(0, -1).join("/");
    const seen = new Set<string>();

    const item = (label: string, pattern: string): MenuEntry | null => {
      if (seen.has(pattern)) return null;
      seen.add(pattern);
      return {
        label,
        title: `Add "${pattern}" to the repo's .gitignore`,
        onSelect: () => void addGitignore(pattern),
      };
    };

    const entries: MenuEntry[] = [];
    const push = (e: MenuEntry | null) => {
      if (e) entries.push(e);
    };
    push(item("This file", `/${rel}`));
    const extMatch = /\.([a-z0-9]{1,8})$/i.exec(name);
    if (extMatch) push(item(`All *.${extMatch[1]} files`, `*.${extMatch[1]}`));
    const wild = numberWildcardName(name);
    if (wild) push(item(wild, dir ? `/${dir}/${wild}` : `/${wild}`));
    for (let n = segs.length - 1; n >= 1; n--) {
      const pattern = `/${segs.slice(0, n).join("/")}/`;
      push(item(`Folder ${pattern}`, pattern));
    }
    return entries;
  };

  /**
   * Smart exclude suggestions for one planned file. Patterns follow the
   * backend's glob rules: matched against the slash-relative path, a bare
   * name matches anywhere in the tree, a trailing "/" takes the whole folder.
   */
  const excludeEntries = (op: BackupFileOp): MenuEntry[] => {
    const rel = op.relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const segs = rel.split("/").filter(Boolean);
    const name = segs[segs.length - 1] ?? rel;
    const dir = segs.slice(0, -1).join("/");
    const seen = new Set<string>();

    const item = (label: string, pattern: string, title?: string): MenuEntry | null => {
      if (seen.has(pattern.toLowerCase())) return null;
      seen.add(pattern.toLowerCase());
      if (excludedLines.has(pattern.toLowerCase())) {
        return { label, hint: "already excluded", disabled: true, title: pattern };
      }
      return {
        label,
        title: title ?? `Add "${pattern}" to the exclude filters`,
        onSelect: () => void addExclude(pattern),
      };
    };

    const entries: MenuEntry[] = [{ type: "header", label: name }];

    const push = (e: MenuEntry | null) => {
      if (e) entries.push(e);
    };

    push(
      item(
        "Exclude this file",
        rel,
        dir
          ? `Add "${rel}" to the exclude filters`
          : `Add "${rel}" — a bare name matches this filename anywhere in the tree`,
      ),
    );

    const extMatch = /\.([a-z0-9]{1,8})$/i.exec(name);
    if (extMatch) {
      push(item(`Exclude all *.${extMatch[1]} files`, `*.${extMatch[1]}`));
    }

    const wild = numberWildcardName(name);
    if (wild) {
      const pattern = dir ? `${dir}/${wild}` : wild;
      push(
        item(
          `Exclude ${wild}${dir ? " in this folder" : ""}`,
          pattern,
          `Numbered variants of this file — add "${pattern}"`,
        ),
      );
    }

    if (segs.length > 1) {
      // Anchored ancestors, nearest first, plus "any folder with this name".
      const folders: MenuEntry[] = [];
      for (let n = segs.length - 1; n >= 1; n--) {
        const pattern = `${segs.slice(0, n).join("/")}/`;
        const e = item(pattern, pattern, `Exclude this folder and everything in it`);
        if (e) folders.push(e);
      }
      const parentName = segs[segs.length - 2];
      const anyE = item(
        `any folder named ${parentName}/`,
        `${parentName}/`,
        `Exclude every folder named "${parentName}" anywhere in the tree`,
      );
      if (anyE) folders.push(anyE);
      if (folders.length === 1) {
        entries.push(folders[0]);
      } else if (folders.length > 1) {
        entries.push({ label: "Exclude folder", children: folders });
      }
    }

    if (info?.git_repo && projectPath) {
      entries.push(
        { type: "separator" },
        {
          label: "Add to .gitignore instead",
          title: respectGitignore
            ? "Write the pattern to the repo's .gitignore — backup honors it while “.gitignore” is on"
            : "Write the pattern to the repo's .gitignore (backup only honors it when the “.gitignore” toggle is on)",
          children: gitignoreEntries(op),
        },
      );
    }

    entries.push(
      { type: "separator" },
      { label: "Edit filters…", onSelect: () => onOpenSettings("backup") },
    );
    return entries;
  };

  const installRclone = async () => {
    setInstalling(true);
    setCloudMsg("Downloading rclone (~20 MB)…");
    try {
      const s = await withOp("rclone-install", "Downloading rclone…", () =>
        api.rcloneInstall(),
      );
      setRc(s);
      setCloudMsg(s.available ? `rclone ${s.version ?? ""} installed` : "");
    } catch (e) {
      setCloudMsg(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const connectProvider = async (ptype: string) => {
    const provider = CLOUD_PROVIDERS.find((p) => p.type === ptype);
    if (!provider || !rc) return;
    const taken = new Set(rc.remotes.map((r) => r.name));
    let name = provider.defaultName;
    for (let i = 2; taken.has(name); i++) name = `${provider.defaultName}-${i}`;
    setConnecting(ptype);
    setCloudMsg(`Approve ${provider.label} access in your browser…`);
    try {
      const s = await withOp(
        "rclone-auth",
        `${provider.label} — approve in browser`,
        () => api.rcloneRemoteAdd(name, ptype),
      );
      setRc(s);
      setCloudMsg("");
      setShowConnect(false);
      pickDest(name);
      onStatusMsg(`${provider.label} connected as "${name}"`);
    } catch (e) {
      setCloudMsg(String(e));
    } finally {
      setConnecting(null);
    }
  };

  const disconnectRemote = async (name: string) => {
    if (!window.confirm(`Disconnect cloud remote "${name}"? Backups on the remote stay.`)) {
      return;
    }
    try {
      const s = await api.rcloneRemoteDelete(name);
      setRc(s);
      if (dest === name) pickDest("folder");
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  if (!canUse) {
    return (
      <div className="right-col backup-side">
        <div className="readme-header">
          <strong>Backup</strong>
        </div>
        <div className="git-side-empty">
          {contextLabel
            ? `Open the ${contextLabel} folder to back up`
            : "Select a project to back up"}
        </div>
      </div>
    );
  }

  const destPicker = (
    <div className="backup-dest-row">
      <span className="tag-bar-label">To</span>
      <div className="view-toggle git-diff-toggle" role="group">
        <button
          type="button"
          className={!cloudDest ? "active" : ""}
          disabled={busy}
          onClick={() => pickDest("folder")}
        >
          folder
        </button>
        {(rc?.remotes ?? []).map((r) => (
          <button
            key={r.name}
            type="button"
            className={dest === r.name ? "active" : ""}
            disabled={busy}
            title={`${r.provider} remote`}
            onClick={() => pickDest(r.name)}
          >
            ☁ {r.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="small ghost"
        title="Connect a cloud service (Google Drive, Dropbox, OneDrive, Box)"
        onClick={() => setShowConnect((v) => !v)}
      >
        + cloud
      </button>
    </div>
  );

  const connectBox = showConnect && (
    <div className="backup-connect">
      {!rc?.available ? (
        <>
          <p className="tag-hint">
            Direct cloud backup uses rclone — a one-time ~20 MB download. Sign-in
            happens in your browser; nothing is stored but the access token, on
            this machine.
          </p>
          <button
            type="button"
            className="primary"
            disabled={installing}
            onClick={() => void installRclone()}
          >
            {installing ? "Downloading…" : "Download rclone"}
          </button>
        </>
      ) : (
        <>
          <p className="tag-hint">
            Pick a service — your browser opens to approve access, then it
            appears as a backup destination.
          </p>
          <div className="backup-connect-providers">
            {CLOUD_PROVIDERS.map((p) => (
              <button
                key={p.type}
                type="button"
                className="small"
                disabled={connecting !== null}
                onClick={() => void connectProvider(p.type)}
              >
                {connecting === p.type ? "Waiting for browser…" : p.label}
              </button>
            ))}
          </div>
          {(rc?.remotes.length ?? 0) > 0 && (
            <div className="backup-connect-existing">
              {rc?.remotes.map((r) => (
                <div key={r.name} className="backup-root-row">
                  <code className="git-path">
                    {r.name} · {r.provider}
                  </code>
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => void disconnectRemote(r.name)}
                  >
                    disconnect
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {cloudMsg && <div className="tag-hint">{cloudMsg}</div>}
    </div>
  );

  if (!cloudDest && !backupRoot.trim() && !remoteOverride.trim()) {
    return (
      <div className="right-col backup-side">
        <div className="readme-header">
          <strong>Backup</strong>
        </div>
        {destPicker}
        {connectBox}
        <div className="git-side-empty">
          <p>
            Pick a root folder for backups — USB drive, or a folder inside OneDrive / Google Drive /
            Dropbox. Or connect a cloud service directly with “+ cloud”.
          </p>
          <button
            type="button"
            className="primary"
            onClick={async () => {
              const folder = await api.pickFolder("Choose backup root folder");
              if (folder) onBackupRootChange(folder);
            }}
          >
            Choose backup root…
          </button>
          <button type="button" className="small ghost" onClick={() => onOpenSettings("backup")}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  const visibleOps = plan
    ? plan.ops.filter((o) =>
        showFiltered
          ? o.direction === "filtered"
          : o.direction === "to_remote" || o.direction === "to_local",
      )
    : [];
  // Sum every matching op, not just the 100 rendered — the header reports the
  // whole transfer ("this run moves 2.3 GB"), which is the decision-relevant bit.
  const pendingBytes = visibleOps.reduce((n, o) => n + (o.bytes || 0), 0);
  // Sort before slicing, so "Size ↓" actually surfaces the biggest files even
  // when the plan runs past the 100-row display cap.
  const pending = [...visibleOps]
    .sort((a, b) => {
      if (sort === "name") return a.relative.localeCompare(b.relative);
      const d = (a.bytes || 0) - (b.bytes || 0);
      return sort === "size-asc" ? d : -d;
    })
    .slice(0, 100);

  const pendingTotal = plan
    ? showFiltered
      ? plan.filtered
      : plan.to_remote + plan.to_local
    : 0;

  return (
    <div className="right-col backup-side">
      <div className="readme-header git-side-header">
        <strong>Backup</strong>
        {contextLabel ? (
          <span className="git-context-chip" title={projectPath ?? undefined}>
            {contextLabel}
          </span>
        ) : null}
        <span className="git-summary-chip" title={info?.remote_root}>
          {busy ? "Working…" : (plan?.summary ?? "—")}
        </span>
        <button type="button" className="small ghost" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {destPicker}
      {connectBox}

      <div className="backup-roots">
        <div className="backup-root-row">
          <span className="tag-bar-label">Local</span>
          <code className="git-path">{info?.local_root ?? "…"}</code>
        </div>
        <div className="backup-root-row">
          <span className="tag-bar-label">Remote</span>
          <code className="git-path" title={info?.remote_root}>
            {info?.remote_root ?? "…"}
          </code>
        </div>
        <div className="backup-root-meta tag-hint">
          {info
            ? cloudDest
              ? `${info.local_file_count} included · ${info.remote_file_count} on remote${
                  info.remote_exists ? "" : " · remote folder not created yet"
                }`
              : `${info.local_file_count} included · ${info.local_filtered} filtered · ${info.remote_file_count} remote${
                  info.remote_exists ? "" : " · remote not created yet"
                }`
            : "—"}
        </div>
      </div>

      <div className="backup-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          title="Copy newer/missing files from project → remote"
          onClick={() => void run("backup")}
        >
          Backup →
        </button>
        {!cloudDest && (
          <button
            type="button"
            className="small"
            disabled={busy}
            title="Two-way: newer wins each side (no deletes)"
            onClick={() => void run("sync")}
          >
            ⇄ Sync
          </button>
        )}
        <button
          type="button"
          className="small"
          disabled={busy}
          title="Copy newer/missing files from remote → project"
          onClick={() => void run("restore")}
        >
          ← Restore
        </button>
        <button type="button" className="small ghost" onClick={() => onOpenSettings("backup")}>
          Filters…
        </button>
        <label
          className="check"
          title={
            info && !info.git_repo
              ? "Not a git repository"
              : "Also skip files matched by the project's .gitignore.\nCareful: TD projects often gitignore exactly the heavy files you may WANT backed up (movies, Backup/*.toe) — enable deliberately."
          }
        >
          <input
            type="checkbox"
            checked={respectGitignore}
            disabled={busy || (info ? !info.git_repo : false)}
            onChange={(e) => onRespectGitignoreChange(e.target.checked)}
          />
          .gitignore
        </label>
      </div>

      <div className="backup-override">
        <label className="tag-hint">
          {cloudDest
            ? "Remote path on the cloud (optional)"
            : "Override remote folder (optional)"}
        </label>
        <div className="backup-override-row">
          <input
            type="text"
            value={remoteOverride}
            placeholder={
              cloudDest
                ? `Default: ${cloudBackupRoot ? `${cloudBackupRoot}/` : ""}${projectFolderName(projectPath)}`
                : "Default: backup root / project name"
            }
            disabled={busy}
            onChange={(e) => setRemoteOverride(e.target.value)}
          />
          {!cloudDest && (
            <button
              type="button"
              className="small"
              disabled={busy}
              onClick={async () => {
                const folder = await api.pickFolder("Choose remote folder for this project");
                if (folder) setRemoteOverride(folder);
              }}
            >
              Browse…
            </button>
          )}
        </div>
      </div>

      <div className="backup-plan">
        <div className="git-changes-head">
          <span>
            {showFiltered ? "Filtered" : "Plan"}
            {plan ? ` (${pendingTotal})` : ""}
            {pendingBytes > 0 ? (
              <span
                className="backup-size-total"
                title={
                  showFiltered
                    ? "Total size of the files being skipped"
                    : "Total size this run will transfer"
                }
              >
                {" "}
                · {formatBytes(pendingBytes)}
              </span>
            ) : null}
            {plan?.gitignore_active ? (
              <span
                className="tag-hint"
                title="Files matched by the project's .gitignore are being skipped"
              >
                {" "}
                · .gitignore
              </span>
            ) : null}
          </span>
          <div className="backup-plan-toggles">
            <select
              className="file-sort-select"
              value={sort}
              title="Sort the planned files"
              disabled={busy}
              onChange={(e) => pickSort(e.target.value as FileSort)}
            >
              <option value="name">Name</option>
              <option value="size-desc">Size ↓</option>
              <option value="size-asc">Size ↑</option>
            </select>
            {!cloudDest && (
              <div className="view-toggle git-diff-toggle" role="group">
                <button
                  type="button"
                  className={!showFiltered ? "active" : ""}
                  disabled={busy}
                  onClick={() => setShowFiltered(false)}
                >
                  changes
                </button>
                <button
                  type="button"
                  className={showFiltered ? "active" : ""}
                  disabled={busy}
                  onClick={() => setShowFiltered(true)}
                >
                  filtered
                </button>
              </div>
            )}
            {!showFiltered && (
              <div className="view-toggle git-diff-toggle" role="group">
                {(cloudDest
                  ? (["backup", "restore"] as const)
                  : (["backup", "sync", "restore"] as const)
                ).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={effectiveMode === m ? "active" : ""}
                    disabled={busy}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="backup-plan-list">
          {!plan ? (
            <div className="git-side-empty subtle">No plan yet</div>
          ) : pending.length === 0 ? (
            <div className="git-side-empty subtle">
              {showFiltered ? "Nothing filtered" : "Nothing to do — already in sync"}
            </div>
          ) : (
            pending.map((op) => (
              <OpRow
                key={`${op.direction}:${op.relative}:${op.reason}`}
                op={op}
                onContextMenu={
                  onOpenMenu
                    ? (e) => onOpenMenu(e, excludeEntries(op))
                    : undefined
                }
              />
            ))
          )}
          {plan && pendingTotal > pending.length && (
            <div className="tag-hint backup-more">…and {pendingTotal - pending.length} more</div>
          )}
        </div>
      </div>

      <div className="backup-footnote tag-hint">
        {cloudDest
          ? "Direct cloud via rclone. Filters from Settings apply. Never deletes."
          : "Filters: exclude / include globs + max size (Settings). Never deletes. Cloud = OS-synced folder, USB, or “+ cloud”."}
      </div>
    </div>
  );
}

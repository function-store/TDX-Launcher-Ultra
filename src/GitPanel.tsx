import { useEffect, useState } from "react";
import { api } from "./api";
import { withOp } from "./ops";
import SplitHandle, { useStoredPx } from "./SplitHandle";
import { loadFileSort, loadGitTab, saveFileSort, saveGitTab, type FileSort } from "./uiPersist";
import type { MenuEntry } from "./ContextMenu";
import { formatBytes, numberWildcardName } from "./utils";
import type {
  GitChange,
  GitCommit,
  GitCommitDetail,
  GitDiff,
  GitStatus,
  GitToolInfo,
} from "./types";

type Props = {
  projectPath: string | null;
  canUse: boolean;
  /** Optional label when the repo is a palette folder rather than a .toe project. */
  contextLabel?: string | null;
  githubUser: string;
  hasToken: boolean;
  onStatusMsg: (msg: string) => void;
  /** Open Settings on a named section (a `data-settings-section` id in App.tsx). */
  onOpenSettings: (section?: string) => void;
  /** Open the app context menu (right-click on changed-file rows). */
  onOpenMenu?: (e: React.MouseEvent, entries: MenuEntry[]) => void;
};

type GitTab = "changes" | "history";

function statusLetter(c: GitChange): string {
  if (c.untracked) return "U";
  const s = c.staged ? c.index_status : c.worktree_status;
  if (s === "A") return "A";
  if (s === "D") return "D";
  if (s === "R") return "R";
  if (s === "M" || s === " ") return "M";
  return s.trim() || "M";
}

function DiffView({
  diff,
  emptyHint = "Select a changed file to preview the diff",
}: {
  diff: GitDiff | null;
  emptyHint?: string;
}) {
  if (!diff) {
    return <div className="git-diff-empty">{emptyHint}</div>;
  }
  if (diff.binary) {
    return <div className="git-diff-empty">Binary file — no text diff</div>;
  }
  if (!diff.text.trim()) {
    return <div className="git-diff-empty">No diff</div>;
  }
  return (
    <pre className="git-diff-pre">
      {diff.text.split("\n").map((line, i) => {
        let cls = "diff-ctx";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "diff-meta";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * "owner/repo" from a remote URL — https, ssh (git@host:owner/repo.git), or
 * anything else with path segments. Falls back to the last segment, or null
 * when the URL yields nothing nameable.
 */
function repoNameFromRemote(url: string): string | null {
  const cleaned = url
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/^[a-z+]+:\/\/[^/]+\//i, "");
  const segs = cleaned.split("/").filter(Boolean);
  if (!segs.length) return null;
  return segs.slice(-2).join("/");
}

export default function GitPanel({
  projectPath,
  canUse,
  contextLabel,
  githubUser,
  hasToken,
  onStatusMsg,
  onOpenSettings,
  onOpenMenu,
}: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<GitTab>(loadGitTab);
  const [commitMsg, setCommitMsg] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  // The remote-URL editor is one-time setup, not something to stare at on
  // every visit — collapsed behind "Remote…" once a remote exists.
  const [remoteEditOpen, setRemoteEditOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
  const [diff, setDiff] = useState<GitDiff | null>(null);

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [changesListH, setChangesListH] = useStoredPx("tdxlu.git.changesH", 200, 100, 700);
  const [historyListH, setHistoryListH] = useStoredPx("tdxlu.git.historyH", 220, 100, 700);
  const [historyFilesH, setHistoryFilesH] = useStoredPx("tdxlu.git.histFilesH", 140, 72, 500);
  const [toolInfo, setToolInfo] = useState<GitToolInfo | null>(null);
  /** Seed a TD-shaped .gitignore when creating a repo (no-repo view only). */
  const [initIgnore, setInitIgnore] = useState(true);
  const [sort, setSort] = useState<FileSort>(() => loadFileSort("gitChanges"));

  const pickSort = (s: FileSort) => {
    setSort(s);
    saveFileSort("gitChanges", s);
  };

  useEffect(() => {
    void api.gitToolInfo().then(setToolInfo).catch(() => setToolInfo(null));
  }, []);

  const refresh = async (path?: string | null) => {
    const p = path ?? projectPath;
    if (!p || !canUse) {
      setStatus(null);
      setDiff(null);
      return;
    }
    try {
      const st = await api.gitStatus(p);
      setStatus(st);
      if (st.remote_urls[0] && !remoteUrl) setRemoteUrl(st.remote_urls[0]);
      if (selectedFile && !st.changes.some((c) => c.path === selectedFile)) {
        setSelectedFile(null);
        setDiff(null);
      }
    } catch (e) {
      setStatus(null);
      onStatusMsg(String(e));
    }
  };

  const refreshHistory = async (path?: string | null) => {
    const p = path ?? projectPath;
    if (!p || !canUse) {
      setCommits([]);
      setDetail(null);
      setSelectedRev(null);
      return;
    }
    setHistoryLoading(true);
    try {
      const list = await api.gitLog(p, 100);
      setCommits(list);
      if (list.length) {
        const keep =
          selectedRev && list.some((c) => c.hash === selectedRev)
            ? selectedRev
            : list[0].hash;
        setSelectedRev(keep);
      } else {
        setSelectedRev(null);
        setDetail(null);
      }
    } catch (e) {
      setCommits([]);
      setDetail(null);
      onStatusMsg(String(e));
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    void refresh(projectPath);
    setSelectedFile(null);
    setDiff(null);
    setCommitMsg("");
    setBranchDraft("");
    // Keep Changes/History tab choice across project switches / restarts
    setCommits([]);
    setSelectedRev(null);
    setHistoryFile(null);
    setDetail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, canUse]);

  useEffect(() => {
    if (tab === "history" && projectPath && status?.is_repo) {
      void refreshHistory(projectPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectPath, status?.is_repo]);

  useEffect(() => {
    if (!projectPath || !selectedFile || !status?.is_repo || tab !== "changes") {
      if (tab !== "changes") setDiff(null);
      return;
    }
    const change = status.changes.find((c) => c.path === selectedFile);
    const preferStaged = change?.staged && !change.unstaged && !change.untracked;
    const useStaged = preferStaged || diffStaged;
    let cancelled = false;
    void api
      .gitDiff(projectPath, selectedFile, useStaged)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff(null);
          onStatusMsg(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, selectedFile, status, diffStaged, onStatusMsg, tab]);

  useEffect(() => {
    if (!projectPath || !selectedRev || tab !== "history") {
      return;
    }
    let cancelled = false;
    void api
      .gitShow(projectPath, selectedRev, historyFile)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDetail(null);
          onStatusMsg(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, selectedRev, historyFile, tab, onStatusMsg]);

  const run = async (label: string, action: () => Promise<GitStatus>) => {
    if (!projectPath || !canUse) return false;
    setBusy(true);
    try {
      const st = await action();
      setStatus(st);
      onStatusMsg(`${label}: ${st.summary}`);
      if (tab === "history") void refreshHistory(projectPath);
      return true;
    } catch (e) {
      onStatusMsg(String(e));
      void refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleStage = async (c: GitChange) => {
    if (!projectPath) return;
    if (c.staged && !c.unstaged && !c.untracked) {
      await run("Unstaged", () => api.gitUnstage(projectPath, [c.path]));
    } else {
      await run("Staged", () => api.gitStage(projectPath, [c.path]));
    }
  };

  const selectFile = (c: GitChange) => {
    setSelectedFile(c.path);
    setDiffStaged(c.staged && !c.unstaged && !c.untracked);
  };

  /** Display order only — git's own ordering stays intact for staging calls. */
  const sortedChanges = [...(status?.changes ?? [])].sort((a, b) => {
    if (sort === "name") return a.path.localeCompare(b.path);
    // Deleted files (null) sort as 0 — they cost nothing either way.
    const d = (a.bytes ?? 0) - (b.bytes ?? 0);
    return sort === "size-asc" ? d : -d;
  });

  // --- "Ignore…" context menu on changed-file rows -------------------------

  const addIgnore = async (pattern: string) => {
    if (!projectPath) return;
    try {
      const added = await api.gitIgnoreAdd(projectPath, pattern);
      onStatusMsg(
        added ? `Added to .gitignore: ${pattern}` : `Already in .gitignore: ${pattern}`,
      );
      if (added) await refresh();
    } catch (e) {
      onStatusMsg(String(e));
    }
  };

  /**
   * Smart .gitignore suggestions for one changed file. Patterns use gitignore
   * semantics: a leading "/" anchors to the repo root, a bare name matches at
   * any depth, a trailing "/" matches directories.
   */
  const ignoreEntries = (c: GitChange): MenuEntry[] => {
    const rel = c.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const segs = rel.split("/").filter(Boolean);
    const name = segs[segs.length - 1] ?? rel;
    const dir = segs.slice(0, -1).join("/");
    const seen = new Set<string>();
    // .gitignore only hides untracked files; a tracked file needs a
    // `git rm --cached` before the pattern takes effect.
    const trackedNote = c.untracked
      ? null
      : "\nAlready tracked — takes effect after the file is untracked (git rm --cached)";

    const item = (label: string, pattern: string, title?: string): MenuEntry | null => {
      if (seen.has(pattern)) return null;
      seen.add(pattern);
      return {
        label,
        title: `${title ?? `Add "${pattern}" to .gitignore`}${trackedNote ?? ""}`,
        onSelect: () => void addIgnore(pattern),
      };
    };

    const entries: MenuEntry[] = [{ type: "header", label: name }];
    const push = (e: MenuEntry | null) => {
      if (e) entries.push(e);
    };

    push(item("Ignore this file", `/${rel}`));

    const extMatch = /\.([a-z0-9]{1,8})$/i.exec(name);
    if (extMatch) {
      push(item(`Ignore all *.${extMatch[1]} files`, `*.${extMatch[1]}`));
    }

    const wild = numberWildcardName(name);
    if (wild) {
      const pattern = dir ? `/${dir}/${wild}` : `/${wild}`;
      push(
        item(
          `Ignore ${wild}${dir ? " in this folder" : ""}`,
          pattern,
          `Numbered variants of this file — add "${pattern}"`,
        ),
      );
    }

    if (segs.length > 1) {
      // Anchored ancestors, nearest first, plus "any folder with this name".
      const folders: MenuEntry[] = [];
      for (let n = segs.length - 1; n >= 1; n--) {
        const pattern = `/${segs.slice(0, n).join("/")}/`;
        const e = item(pattern, pattern, "Ignore this folder and everything in it");
        if (e) folders.push(e);
      }
      const parentName = segs[segs.length - 2];
      const anyE = item(
        `any folder named ${parentName}/`,
        `${parentName}/`,
        `Ignore every folder named "${parentName}" anywhere in the repo`,
      );
      if (anyE) folders.push(anyE);
      if (folders.length === 1) entries.push(folders[0]);
      else if (folders.length > 1) entries.push({ label: "Ignore folder", children: folders });
    }

    if (status?.root) {
      const root = status.root;
      entries.push(
        { type: "separator" },
        {
          label: "Open .gitignore",
          onSelect: () => void api.openPath(`${root}/.gitignore`),
        },
      );
    }
    return entries;
  };

  const selectCommit = (hash: string) => {
    setSelectedRev(hash);
    setHistoryFile(null);
  };

  if (!canUse) {
    return (
      <div className="right-col git-side">
        <div className="readme-header">
          <strong>Git</strong>
        </div>
        <div className="git-side-empty">
          {contextLabel
            ? `Open the ${contextLabel} folder to use Git`
            : "Select a project to use Git"}
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="right-col git-side">
        <div className="readme-header">
          <strong>Git</strong>
        </div>
        <div className="git-side-empty">{busy ? "Working…" : "Loading…"}</div>
      </div>
    );
  }

  if (!status.is_repo) {
    return (
      <div className="right-col git-side">
        <div className="readme-header">
          <strong>Git</strong>
        </div>
        <div className="git-side-empty">
          <p>No repository in</p>
          <code className="git-path">{status.project_dir}</code>
          <label
            className="git-init-ignore"
            title={
              "Write a starting .gitignore for TouchDesigner: Backup/, Project.N.toe " +
              "increments, CrashAutoSave files, __pycache__, OS junk.\nHeavy media is " +
              "listed but commented out — uncomment what your project regenerates.\n" +
              "An existing .gitignore is never overwritten."
            }
          >
            <input
              type="checkbox"
              checked={initIgnore}
              disabled={busy}
              onChange={(e) => setInitIgnore(e.target.checked)}
            />
            Add a TouchDesigner .gitignore
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                initIgnore ? "Created repo with .gitignore" : "Created repo",
                () => api.gitInit(projectPath!, initIgnore),
              )
            }
          >
            Create repository
          </button>
        </div>
      </div>
    );
  }

  const authLabel = hasToken
    ? githubUser
      ? `App token: ${githubUser}`
      : "App token set (overrides GitHub HTTPS)"
    : toolInfo?.available
      ? toolInfo.credential_helper
        ? `System Git · helper: ${toolInfo.credential_helper}`
        : "System Git · using stored credentials if any"
      : "System git not found";

  const authTitle = [
    toolInfo?.version,
    toolInfo?.path,
    toolInfo?.note,
    hasToken ? "Settings token overrides github.com HTTPS auth." : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="right-col git-side">
      <div className="readme-header git-side-header">
        <strong>Git</strong>
        {contextLabel ? (
          <span className="git-context-chip" title={projectPath ?? undefined}>
            {contextLabel}
          </span>
        ) : null}
        <span className="git-summary-chip" title={status.root ?? undefined}>
          {status.summary}
        </span>
        {(() => {
          // Name the repo the panel is looking at — the remote URL was the
          // only identity on screen, and only in the editor at the bottom.
          const url = status.remote_urls[0];
          const name = url ? repoNameFromRemote(url) : null;
          if (!name) return null;
          const webUrl = /^https?:\/\//i.test(url);
          return (
            <button
              type="button"
              className="git-repo-chip"
              title={webUrl ? `${url}\nOpen in browser` : url}
              onClick={() => {
                if (webUrl) void api.openUrl(url.replace(/\.git\/?$/i, ""));
              }}
            >
              {name}
            </button>
          );
        })()}
        <button
          type="button"
          className="small ghost"
          disabled={busy || historyLoading}
          onClick={() => {
            void refresh();
            if (tab === "history") void refreshHistory();
          }}
        >
          Refresh
        </button>
      </div>

      <div className="git-toolbar">
        <label className="git-branch-label">
          Branch
          <select
            className="git-select"
            value={status.branch ?? ""}
            disabled={busy || status.branches.length === 0}
            onChange={(e) => {
              const next = e.target.value;
              if (!next || next === status.branch) return;
              void run(`Switched to ${next}`, () => api.gitCheckout(projectPath!, next, false));
            }}
          >
            {status.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <form
          className="git-branch-new"
          onSubmit={(e) => {
            e.preventDefault();
            const name = branchDraft.trim();
            if (!name) return;
            void run(`Created ${name}`, () => api.gitCheckout(projectPath!, name, true)).then(
              (ok) => {
                if (ok) setBranchDraft("");
              },
            );
          }}
        >
          <input
            type="text"
            value={branchDraft}
            placeholder="New branch"
            disabled={busy}
            onChange={(e) => setBranchDraft(e.target.value)}
          />
          <button type="submit" className="small" disabled={busy || !branchDraft.trim()}>
            Create
          </button>
        </form>
        <button
          type="button"
          className="small"
          disabled={busy || status.remotes.length === 0}
          onClick={() =>
            void run("Pulled", () =>
              withOp("git", "Pull ← origin", () => api.gitPull(projectPath!, "origin")),
            )
          }
        >
          Pull
        </button>
        <button
          type="button"
          className="small"
          disabled={busy || status.remotes.length === 0}
          onClick={() =>
            void run("Pushed", () =>
              withOp("git", "Push → origin", () =>
                api.gitPush(projectPath!, "origin", !status.has_upstream),
              ),
            )
          }
        >
          Push
        </button>
      </div>

      <div className="git-auth-row">
        <span className="tag-hint" title={authTitle || undefined}>
          {authLabel}
        </span>
        <button type="button" className="small ghost" onClick={() => onOpenSettings("github")}>
          Token…
        </button>
      </div>

      <div className="view-toggle git-main-tabs" role="tablist" aria-label="Git view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          className={tab === "changes" ? "active" : ""}
          onClick={() => {
            setTab("changes");
            saveGitTab("changes");
          }}
        >
          Changes{status.dirty ? ` (${status.changes.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "active" : ""}
          onClick={() => {
            setTab("history");
            saveGitTab("history");
          }}
        >
          History
        </button>
      </div>

      {tab === "changes" ? (
        <>
          <div className="git-split">
            <div
              className="git-changes"
              style={{ height: changesListH, flex: "0 0 auto" }}
            >
              <div className="git-changes-head">
                <span>
                  Files
                  {(() => {
                    const total = status.changes.reduce((n, c) => n + (c.bytes ?? 0), 0);
                    return total > 0 ? (
                      <span
                        className="git-size-total"
                        title="Total size of the changed files on disk"
                      >
                        {" "}
                        · {formatBytes(total)}
                      </span>
                    ) : null;
                  })()}
                </span>
                <div className="git-changes-actions">
                  <button
                    type="button"
                    className="small ghost"
                    disabled={busy || !status.dirty}
                    onClick={() => void run("Staged all", () => api.gitStage(projectPath!, []))}
                  >
                    Stage all
                  </button>
                  <button
                    type="button"
                    className="small ghost"
                    disabled={busy || status.staged === 0}
                    onClick={() => void run("Unstaged all", () => api.gitUnstage(projectPath!, []))}
                  >
                    Unstage
                  </button>
                  <select
                    className="file-sort-select"
                    value={sort}
                    title="Sort the changed files"
                    onChange={(e) => pickSort(e.target.value as FileSort)}
                  >
                    <option value="name">Name</option>
                    <option value="size-desc">Size ↓</option>
                    <option value="size-asc">Size ↑</option>
                  </select>
                </div>
              </div>
              <div className="git-file-list">
                {status.changes.length === 0 ? (
                  <div className="git-side-empty subtle">Working tree clean</div>
                ) : (
                  sortedChanges.map((c) => {
                    const active = selectedFile === c.path;
                    const letter = statusLetter(c);
                    return (
                      <div
                        key={c.path}
                        className={`git-file-row ${active ? "active" : ""}`}
                        onClick={() => selectFile(c)}
                        onContextMenu={
                          onOpenMenu
                            ? (e) => {
                                selectFile(c);
                                onOpenMenu(e, ignoreEntries(c));
                              }
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={c.staged}
                          title={c.staged ? "Staged — click to unstage" : "Click to stage"}
                          disabled={busy}
                          onChange={(e) => {
                            e.stopPropagation();
                            void toggleStage(c);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className={`git-letter letter-${letter}`}>{letter}</span>
                        <span className="git-file-name" title={c.path}>
                          {c.path}
                        </span>
                        {c.bytes != null && (
                          <span className="git-file-size">{formatBytes(c.bytes)}</span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <SplitHandle
              axis="y"
              title="Drag to resize files / diff"
              onDelta={(d) => setChangesListH((h) => h + d)}
            />

            <div className="git-diff-pane">
              <div className="git-changes-head">
                <span>{selectedFile ? selectedFile : "Diff"}</span>
                {selectedFile && (
                  <div className="view-toggle git-diff-toggle" role="group">
                    <button
                      type="button"
                      className={!diffStaged ? "active" : ""}
                      onClick={() => setDiffStaged(false)}
                    >
                      Working
                    </button>
                    <button
                      type="button"
                      className={diffStaged ? "active" : ""}
                      onClick={() => setDiffStaged(true)}
                    >
                      Staged
                    </button>
                  </div>
                )}
              </div>
              <div className="git-diff-body">
                <DiffView diff={diff} />
              </div>
            </div>
          </div>

          <div className="git-commit-box">
            <textarea
              value={commitMsg}
              placeholder="Commit message"
              disabled={busy}
              rows={2}
              onChange={(e) => setCommitMsg(e.target.value)}
            />
            <div className="git-commit-actions">
              <button
                type="button"
                className="small"
                disabled={busy || !commitMsg.trim()}
                title="Stage all changes, then commit"
                onClick={() =>
                  void run("Committed", () =>
                    api.gitCommit(projectPath!, commitMsg.trim(), true),
                  ).then((ok) => {
                    if (ok) setCommitMsg("");
                  })
                }
              >
                Commit all
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !commitMsg.trim() || status.staged === 0}
                title="Commit staged files only"
                onClick={() =>
                  void run("Committed", () =>
                    api.gitCommit(projectPath!, commitMsg.trim(), false),
                  ).then((ok) => {
                    if (ok) setCommitMsg("");
                  })
                }
              >
                Commit staged
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="git-split git-history-split">
          <div
            className="git-changes git-history-list"
            style={{ height: historyListH, flex: "0 0 auto" }}
          >
            <div className="git-changes-head">
              <span>Commits ({commits.length})</span>
            </div>
            <div className="git-file-list">
              {historyLoading && commits.length === 0 ? (
                <div className="git-side-empty subtle">Loading history…</div>
              ) : commits.length === 0 ? (
                <div className="git-side-empty subtle">No commits yet</div>
              ) : (
                commits.map((c) => {
                  const active = selectedRev === c.hash;
                  return (
                    <button
                      type="button"
                      key={c.hash}
                      className={`git-commit-row ${active ? "active" : ""}`}
                      onClick={() => selectCommit(c.hash)}
                    >
                      <span className="git-commit-subject" title={c.subject}>
                        {c.subject || "(no subject)"}
                      </span>
                      <span className="git-commit-meta">
                        <code>{c.short_hash}</code>
                        <span>{c.author}</span>
                        <span>{c.relative_time}</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <SplitHandle
            axis="y"
            title="Drag to resize commits / detail"
            onDelta={(d) => setHistoryListH((h) => h + d)}
          />

          <div className="git-diff-pane">
            <div className="git-changes-head">
              <span>
                {detail
                  ? `${detail.commit.short_hash} — ${detail.commit.subject}`
                  : "Commit"}
              </span>
            </div>
            {detail ? (
              <div className="git-history-detail">
                <div className="git-history-msg">
                  <div className="git-history-msg-meta">
                    {detail.commit.author} &lt;{detail.commit.email}&gt; ·{" "}
                    {detail.commit.relative_time}
                  </div>
                  {detail.body ? <pre className="git-history-body">{detail.body}</pre> : null}
                </div>
                <div
                  className="git-history-files"
                  style={{ height: historyFilesH, flex: "0 0 auto" }}
                >
                  <button
                    type="button"
                    className={`git-file-row ${historyFile == null ? "active" : ""}`}
                    onClick={() => setHistoryFile(null)}
                  >
                    <span className="git-letter">*</span>
                    <span className="git-file-name">All changes ({detail.files.length})</span>
                  </button>
                  {detail.files.map((f) => (
                    <button
                      type="button"
                      key={f.path}
                      className={`git-file-row ${historyFile === f.path ? "active" : ""}`}
                      onClick={() => setHistoryFile(f.path)}
                    >
                      <span className={`git-letter letter-${f.status}`}>{f.status}</span>
                      <span className="git-file-name" title={f.path}>
                        {f.path}
                      </span>
                    </button>
                  ))}
                </div>
                <SplitHandle
                  axis="y"
                  title="Drag to resize files / diff"
                  onDelta={(d) => setHistoryFilesH((h) => h + d)}
                />
                <div className="git-diff-body git-history-diff">
                  <DiffView
                    diff={detail.diff}
                    emptyHint="No patch for this commit"
                  />
                </div>
              </div>
            ) : (
              <div className="git-diff-body">
                <div className="git-diff-empty">
                  {historyLoading ? "Loading…" : "Select a commit"}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="git-remote-box">
        {/* With no remote yet, the form IS the call to action; once one is
            set, the repo chip in the header carries the identity and the
            editor collapses behind a small affordance. */}
        {status.remotes.length === 0 || remoteEditOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = remoteUrl.trim();
              if (!url) return;
              void run("Remote set", () => api.gitSetRemote(projectPath!, "origin", url)).then(
                (ok) => {
                  if (ok) setRemoteEditOpen(false);
                },
              );
            }}
          >
            <input
              type="text"
              value={remoteUrl}
              placeholder="Remote URL (origin)"
              disabled={busy}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <button type="submit" className="small" disabled={busy || !remoteUrl.trim()}>
              {status.remotes.includes("origin") ? "Update remote" : "Add remote"}
            </button>
            {status.remotes.length > 0 && (
              <button
                type="button"
                className="small ghost"
                disabled={busy}
                onClick={() => {
                  setRemoteEditOpen(false);
                  if (status.remote_urls[0]) setRemoteUrl(status.remote_urls[0]);
                }}
              >
                Cancel
              </button>
            )}
          </form>
        ) : (
          <button
            type="button"
            className="small ghost git-remote-edit"
            title={status.remote_urls[0] ?? undefined}
            onClick={() => setRemoteEditOpen(true)}
          >
            Remote…
          </button>
        )}
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  ControlAddResult,
  ControlCompEntry,
  ControlCompsResult,
  ControlParDescriptor,
  ControlSchemaResult,
  ControlSetResult,
  ControlTarget,
  ControlValuesResult,
} from "./types";

/** How the panel reaches the utility: Tauri IPC in-app, fetch in a browser.
 * The comps/addComp/removeComp trio backs the quiet "expose a component"
 * affordance — optional so older transports simply hide it. */
export type ControlTransport = {
  schema: (path: string) => Promise<ControlSchemaResult>;
  values: (path: string) => Promise<ControlValuesResult>;
  set: (
    path: string,
    sets: { target: string; par: string; value: unknown }[],
  ) => Promise<ControlSetResult>;
  comps?: (path: string, parent?: string) => Promise<ControlCompsResult>;
  addComp?: (path: string, comp: string) => Promise<ControlAddResult>;
  removeComp?: (path: string, key: string) => Promise<ControlAddResult>;
};

const tauriTransport: ControlTransport = {
  schema: (p) => api.controlSchema(p),
  values: (p) => api.controlValues(p),
  set: (p, s) => api.controlSet(p, s),
  comps: (p, parent) => api.controlComps(p, parent),
  addComp: (p, c) => api.controlAddComp(p, c),
  removeComp: (p, k) => api.controlRemoveComp(p, k),
};

type Props = {
  /** Selected running session's .toe path (Current tab). */
  projectPath: string | null;
  canUse: boolean;
  onStatusMsg: (msg: string) => void;
  /** Defaults to Tauri IPC; the standalone browser page passes fetch. */
  transport?: ControlTransport;
  /** In-app only: opens the panel in the default browser. */
  onOpenBrowser?: () => void;
  /** In-app only: one-tap phone pairing (LAN + QR modal). */
  onPhoneRemote?: () => void;
  /** Touch surface (the phone page): enables −/+ nudge steppers, a param
   * search box, and pinnable favorites. Off on the compact desktop sidebar. */
  touch?: boolean;
};

const VALUE_POLL_MS = 1000;
/** Every Nth poll re-fetches the schema so filter/page edits in TD show up. */
const SCHEMA_EVERY = 10;
/** Poll data may not overwrite a par the user edited within this window —
 * an in-flight poll response is up to a poll period stale. */
const EDIT_HOLD_MS = 1500;

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function sliderBounds(p: ControlParDescriptor): { lo: number; hi: number } | null {
  const lo = p.normmin ?? p.min;
  const hi = p.normmax ?? p.max;
  if (lo == null || hi == null || !isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
  return { lo, hi };
}

/** A single −/+ tap's nudge for a numeric par: coarse enough to feel on a
 * thumb, fine enough to be useful. Int steps by 1; a bounded float by ~1% of
 * its range snapped to a clean 1/2/5 decimal; an unbounded float by 0.01. */
function nudgeStep(p: ControlParDescriptor): number {
  if (p.style === "Int") return 1;
  const b = sliderBounds(p);
  if (!b) return 0.01;
  const raw = (b.hi - b.lo) / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

/** Clamp to the par's declared range (only where clamping is enabled) and
 * shave float dust so a nudge lands on a clean value. */
function clampToPar(p: ControlParDescriptor, v: number): number {
  let out = v;
  if (p.clampmin && p.min != null) out = Math.max(p.min, out);
  if (p.clampmax && p.max != null) out = Math.min(p.max, out);
  return Math.round(out * 1e6) / 1e6;
}

/** Stable pin identity for a row within a target: a single par by name, a
 * ParGroup by its tuplet stem (so the whole group pins/moves as one). */
function rowPinKey(targetKey: string, row: ControlParDescriptor | ControlParDescriptor[]): string {
  return Array.isArray(row)
    ? `${targetKey}|@${row[0].tuplet}`
    : `${targetKey}|${row.name}`;
}

/** Does a row match the search filter? Matches label or par name (any
 * component for a group). Empty filter matches everything. */
function rowMatches(row: ControlParDescriptor | ControlParDescriptor[], q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = (p: ControlParDescriptor) =>
    (p.label || "").toLowerCase().includes(needle) ||
    p.name.toLowerCase().includes(needle) ||
    (p.tuplet || "").toLowerCase().includes(needle);
  return Array.isArray(row) ? row.some(hay) : hay(row);
}

/** Rows to render: consecutive pars of one multi-par ParGroup collapse into one row. */
function buildRows(pars: ControlParDescriptor[]): (ControlParDescriptor | ControlParDescriptor[])[] {
  const rows: (ControlParDescriptor | ControlParDescriptor[])[] = [];
  for (const p of pars) {
    const last = rows[rows.length - 1];
    if (
      (p.tupletsize ?? 1) > 1 &&
      Array.isArray(last) &&
      last[0].tuplet === p.tuplet &&
      last[0].page === p.page
    ) {
      last.push(p);
    } else if ((p.tupletsize ?? 1) > 1) {
      rows.push([p]);
    } else {
      rows.push(p);
    }
  }
  return rows;
}

type Row = ControlParDescriptor | ControlParDescriptor[];

/** A row's parameter page (from its first component). */
function rowPage(row: Row): string {
  return (Array.isArray(row) ? row[0].page : row.page) || "";
}

/** Split rows into their parameter pages, preserving first-seen order — so the
 *  panel mirrors the COMP's own Custom-page tabs instead of one flat dump. */
function groupByPage(rows: Row[]): { page: string; rows: Row[] }[] {
  const order: string[] = [];
  const byPage = new Map<string, Row[]>();
  for (const row of rows) {
    const pg = rowPage(row);
    if (!byPage.has(pg)) {
      byPage.set(pg, []);
      order.push(pg);
    }
    byPage.get(pg)!.push(row);
  }
  return order.map((page) => ({ page, rows: byPage.get(page)! }));
}

/** Remember where the user last traversed the component tree, per project, so
 *  reopening "Expose a component" restores the same open folders. Kept in
 *  localStorage — the only cached bit; the COMP scan itself is always live. */
const EXPANDED_STORE_KEY = "tdxlu.control.compExpanded";

function loadExpandedPaths(project: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(EXPANDED_STORE_KEY) || "{}");
    return Array.isArray(all[project]) ? all[project] : [];
  } catch {
    return [];
  }
}

function saveExpandedPaths(project: string, paths: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(EXPANDED_STORE_KEY) || "{}");
    if (paths.length) all[project] = paths;
    else delete all[project];
    localStorage.setItem(EXPANDED_STORE_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — traversal memory is a nicety, not essential */
  }
}

function toHex(vals: number[]): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(vals[0] ?? 0)}${c(vals[1] ?? 0)}${c(vals[2] ?? 0)}`;
}

/** One ParGroup row: shared label, per-component number entries, color swatch
 * for RGB(A). Expandable (chevron / label tap) into one full slider row per
 * component — compact tuplet entries are fine for typing but hopeless for
 * dragging, especially on a phone. */
function GroupRow({
  pars,
  values,
  disabled,
  onCommitMany,
  touch,
  pinned,
  onTogglePin,
}: {
  pars: ControlParDescriptor[];
  values: Record<string, unknown>;
  disabled: boolean;
  onCommitMany: (sets: { par: string; value: unknown }[]) => void;
  touch?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const colorTimer = useRef<number | null>(null);
  const first = pars[0];
  const isColor = (first.style === "RGB" || first.style === "RGBA") && pars.length >= 3;
  const nums = pars.map((p) => {
    const v = values[p.name];
    return typeof v === "number" ? v : Number(v ?? 0);
  });
  const lockedOf = (p: ControlParDescriptor) => disabled || p.readonly || p.mode !== "CONSTANT";
  const allLocked = pars.every(lockedOf);
  const modeBadge = pars.some((p) => p.mode !== "CONSTANT");

  const clearDraft = (name: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[name];
      return next;
    });

  /** "R" / "G" / "X" / "Y" — the component's name minus the tuplet stem. */
  const compLabel = (p: ControlParDescriptor, i: number) => {
    const stem = (first.tuplet ?? "").toLowerCase();
    const name = p.name;
    if (stem && name.toLowerCase().startsWith(stem) && name.length > stem.length) {
      return name.slice(stem.length).toUpperCase();
    }
    return String(i + 1);
  };

  const numberEntry = (p: ControlParDescriptor, i: number, className: string) => (
    <input
      key={p.name}
      type="number"
      className={className}
      title={p.name}
      step={p.style === "Int" ? 1 : "any"}
      value={drafts[p.name] ?? (isFinite(nums[i]) ? String(nums[i]) : "")}
      disabled={lockedOf(p)}
      onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
      onBlur={() => {
        const dv = drafts[p.name];
        if (dv != null && dv !== "" && Number(dv) !== nums[i])
          onCommitMany([{ par: p.name, value: Number(dv) }]);
        clearDraft(p.name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") clearDraft(p.name);
      }}
    />
  );

  return (
    <>
      <div className={`control-par-row${allLocked ? " control-locked" : ""}`}>
        <span
          className="control-par-label control-group-label"
          title={`${first.tuplet} · page ${first.page} — click to ${
            expanded ? "collapse" : "expand into per-component sliders"
          }`}
          onClick={() => setExpanded((e) => !e)}
        >
          {onTogglePin && <PinStar pinned={!!pinned} onToggle={onTogglePin} />}
          <span className="control-expand">{expanded ? "▾" : "▸"}</span>
          {first.label || first.tuplet}
          {modeBadge && <em className="control-mode-badge">expr</em>}
        </span>
        <span className="control-num">
          {isColor && (
            <input
              type="color"
              className="control-color"
              value={toHex(nums)}
              disabled={allLocked}
              onChange={(e) => {
                const hex = e.target.value;
                const rgb = [1, 3, 5].map(
                  (i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000,
                );
                if (colorTimer.current) window.clearTimeout(colorTimer.current);
                // Debounce: the OS picker streams change events while dragging.
                colorTimer.current = window.setTimeout(() => {
                  onCommitMany(pars.slice(0, 3).map((p, i) => ({ par: p.name, value: rgb[i] })));
                }, 150);
              }}
            />
          )}
          {!expanded &&
            pars.map((p, i) => numberEntry(p, i, "control-num-entry control-group-entry"))}
        </span>
      </div>
      {expanded &&
        pars.map((p, i) => {
          const bounds = sliderBounds(p);
          const locked = lockedOf(p);
          const num = nums[i];
          const nudge = (dir: 1 | -1) =>
            onCommitMany([
              { par: p.name, value: clampToPar(p, (isFinite(num) ? num : 0) + dir * nudgeStep(p)) },
            ]);
          return (
            <div
              key={p.name}
              className={`control-par-row control-sub-row${locked ? " control-locked" : ""}`}
            >
              <span className="control-par-label" title={`${p.name} · page ${p.page}`}>
                {compLabel(p, i)}
              </span>
              <span className="control-num">
                {bounds && (
                  <input
                    type="range"
                    min={bounds.lo}
                    max={bounds.hi}
                    step={p.style === "Int" ? 1 : (bounds.hi - bounds.lo) / 200}
                    value={isFinite(num) ? num : bounds.lo}
                    disabled={locked}
                    style={
                      {
                        "--fill": `${Math.max(0, Math.min(100, ((num - bounds.lo) / (bounds.hi - bounds.lo)) * 100))}%`,
                      } as React.CSSProperties
                    }
                    onChange={(e) =>
                      onCommitMany([{ par: p.name, value: Number(e.target.value) }])
                    }
                  />
                )}
                {touch && p.style === "Int" && (
                  <button type="button" className="control-step" disabled={locked} onClick={() => nudge(-1)}>
                    −
                  </button>
                )}
                {numberEntry(p, i, "control-num-entry")}
                {touch && p.style === "Int" && (
                  <button type="button" className="control-step" disabled={locked} onClick={() => nudge(1)}>
                    +
                  </button>
                )}
              </span>
            </div>
          );
        })}
    </>
  );
}

/** A star toggle that pins a row to the top. Stops propagation so pinning a
 * ParGroup row doesn't also fire the row's expand toggle. */
function PinStar({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`control-pin ${pinned ? "pinned" : ""}`}
      title={pinned ? "Unpin" : "Pin to top"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {pinned ? "★" : "☆"}
    </button>
  );
}

/** One parameter row. Text-ish inputs commit on Enter/blur; the rest on change. */
function ParRow({
  par,
  value,
  disabled,
  onCommit,
  touch,
  pinned,
  onTogglePin,
}: {
  par: ControlParDescriptor;
  value: unknown;
  disabled: boolean;
  onCommit: (value: unknown) => void;
  touch?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const locked = disabled || par.readonly || par.mode !== "CONSTANT";
  const modeBadge = par.mode !== "CONSTANT" ? par.mode.toLowerCase() : null;

  let control: React.ReactElement;
  if (par.style === "Pulse") {
    control = (
      <button
        type="button"
        className="small"
        disabled={disabled || par.readonly}
        onClick={() => onCommit(1)}
      >
        Pulse
      </button>
    );
  } else if (par.style === "Toggle") {
    control = (
      <input
        type="checkbox"
        checked={!!value}
        disabled={locked}
        onChange={(e) => onCommit(e.target.checked ? 1 : 0)}
      />
    );
  } else if (par.style === "Menu" && par.menunames?.length) {
    control = (
      <select
        value={String(value ?? "")}
        disabled={locked}
        onChange={(e) => onCommit(e.target.value)}
      >
        {par.menunames.map((n, i) => (
          <option key={n} value={n}>
            {par.menulabels?.[i] ?? n}
          </option>
        ))}
      </select>
    );
  } else if (par.style === "Float" || par.style === "Int") {
    const bounds = sliderBounds(par);
    const num = typeof value === "number" ? value : Number(value ?? 0);
    // Steppers only for ints: a float has the slider for continuous control and
    // the entry for an exact value, so a fixed nudge amount adds little.
    const showStep = touch && par.style === "Int";
    const nudge = (dir: 1 | -1) =>
      onCommit(clampToPar(par, (isFinite(num) ? num : 0) + dir * nudgeStep(par)));
    control = (
      <span className="control-num">
        {bounds && (
          <input
            type="range"
            min={bounds.lo}
            max={bounds.hi}
            step={par.style === "Int" ? 1 : (bounds.hi - bounds.lo) / 200}
            value={isFinite(num) ? num : bounds.lo}
            disabled={locked}
            style={
              {
                // Drives the themed track's filled portion (see App.css) —
                // appearance:none discards the native accent fill.
                "--fill": `${Math.max(0, Math.min(100, ((num - bounds.lo) / (bounds.hi - bounds.lo)) * 100))}%`,
              } as React.CSSProperties
            }
            onChange={(e) => onCommit(Number(e.target.value))}
          />
        )}
        {showStep && (
          <button type="button" className="control-step" disabled={locked} onClick={() => nudge(-1)}>
            −
          </button>
        )}
        <input
          type="number"
          className="control-num-entry"
          step={par.style === "Int" ? 1 : "any"}
          value={draft ?? (isFinite(num) ? String(num) : "")}
          disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft != null && draft !== "" && Number(draft) !== num) onCommit(Number(draft));
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraft(null);
          }}
        />
        {showStep && (
          <button type="button" className="control-step" disabled={locked} onClick={() => nudge(1)}>
            +
          </button>
        )}
      </span>
    );
  } else {
    // Str, StrMenu, File, Folder, OP-reference styles
    control = (
      <input
        type="text"
        className="control-text-entry"
        value={draft ?? String(value ?? "")}
        disabled={locked}
        list={par.style === "StrMenu" && par.menunames?.length ? `ctl-${par.name}` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft != null && draft !== String(value ?? "")) onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    );
  }

  return (
    <div className={`control-par-row${locked ? " control-locked" : ""}`}>
      <span className="control-par-label" title={`${par.name} · page ${par.page}`}>
        {onTogglePin && <PinStar pinned={!!pinned} onToggle={onTogglePin} />}
        {par.label || par.name}
        {modeBadge && <em className="control-mode-badge">{modeBadge}</em>}
      </span>
      {control}
      {par.style === "StrMenu" && par.menunames?.length ? (
        <datalist id={`ctl-${par.name}`}>
          {par.menunames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

export default function ControlPanel({
  projectPath,
  canUse,
  onStatusMsg,
  transport,
  onOpenBrowser,
  onPhoneRemote,
  touch,
}: Props) {
  const tr = transport ?? tauriTransport;
  const [schema, setSchema] = useState<ControlSchemaResult | null>(null);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [pins, setPins] = useState<Set<string>>(new Set());
  // "Expose a component" browser (quiet affordance below the targets).
  const [addOpen, setAddOpen] = useState(false);
  // Lazy component tree: children keyed by parent path ("" = root layer),
  // fetched on demand as folders expand. Never cached across opens — only the
  // set of expanded paths is remembered (localStorage).
  const [compChildren, setCompChildren] = useState<Record<string, ControlCompEntry[]>>({});
  const [compExpanded, setCompExpanded] = useState<Set<string>>(new Set());
  const [compLoading, setCompLoading] = useState<Set<string>>(new Set());
  const [compRootLoaded, setCompRootLoaded] = useState(false);
  const [compsErr, setCompsErr] = useState<string | null>(null);
  /** Target key whose remove (×) is armed, awaiting a confirm click. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** Active parameter page per target (`${targetKey}` → page name). */
  const [activePage, setActivePage] = useState<Record<string, string>>({});
  const pollRef = useRef(0);
  /** Targets with a controlSet in flight — at most one write per target at a time. */
  const inflightRef = useRef<Set<string>>(new Set());
  /** Latest queued value per par while a write is in flight (coalesced trailing send). */
  const pendingRef = useRef<Map<string, Map<string, unknown>>>(new Map());
  /** "target:par" -> last local edit time; polls must not overwrite fresher edits. */
  const editStampRef = useRef<Map<string, number>>(new Map());

  // Pinned favorites persist per project so the phone reopens with your key
  // faders already at the top. Keyed by the .toe path; touch surface only.
  const pinStoreKey = projectPath ? `tdxlu-pins:${projectPath}` : null;
  useEffect(() => {
    if (!touch || !pinStoreKey) {
      setPins(new Set());
      return;
    }
    try {
      const raw = window.localStorage.getItem(pinStoreKey);
      setPins(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setPins(new Set());
    }
  }, [touch, pinStoreKey]);

  const togglePin = useCallback(
    (key: string) => {
      setPins((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        if (pinStoreKey) {
          try {
            window.localStorage.setItem(pinStoreKey, JSON.stringify([...next]));
          } catch {
            /* storage full / disabled — pins just won't persist */
          }
        }
        return next;
      });
    },
    [pinStoreKey],
  );

  /** Fetch one tree layer — the immediate COMP children of `parent` ("" =
   *  root). Live every time; results land in compChildren[parent]. */
  const loadLayer = useCallback(
    async (parent: string) => {
      if (!projectPath || !tr.comps) return;
      setCompLoading((s) => new Set(s).add(parent));
      try {
        const r = await tr.comps(projectPath, parent || undefined);
        if (r.ok) {
          setCompChildren((m) => ({ ...m, [parent]: r.comps ?? [] }));
          setCompsErr(null);
        } else {
          setCompsErr(r.error || "could not list components");
        }
      } catch (e) {
        setCompsErr(String(e));
      } finally {
        setCompLoading((s) => {
          const n = new Set(s);
          n.delete(parent);
          return n;
        });
      }
    },
    [projectPath, tr],
  );

  /** Open the scan: load the top layer fresh, then restore the last traversal
   *  (remembered expanded folders) by fetching each of their layers. */
  const openCompScan = useCallback(async () => {
    setCompChildren({});
    setCompsErr(null);
    setCompRootLoaded(false);
    await loadLayer("");
    setCompRootLoaded(true);
    const remembered = loadExpandedPaths(projectPath || "");
    if (remembered.length) {
      setCompExpanded(new Set(remembered));
      // Shallow paths first so a parent's children exist before its child opens.
      for (const p of [...remembered].sort((a, b) => a.length - b.length)) {
        await loadLayer(p);
      }
    }
  }, [projectPath, loadLayer]);

  /** Expand/collapse a folder — fetches its layer on first expand; persists the
   *  expanded set so the traversal is remembered next open. */
  const toggleExpand = useCallback(
    (path: string) => {
      setCompExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!compChildren[path]) void loadLayer(path);
        }
        saveExpandedPaths(projectPath || "", [...next]);
        return next;
      });
    },
    [compChildren, loadLayer, projectPath],
  );

  // New session — start the browser closed with stale data dropped.
  useEffect(() => {
    setAddOpen(false);
    setCompChildren({});
    setCompExpanded(new Set());
    setCompLoading(new Set());
    setCompRootLoaded(false);
    setCompsErr(null);
    setConfirmRemove(null);
  }, [projectPath]);

  const loadSchema = useCallback(async () => {
    if (!projectPath || !canUse) {
      setSchema(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const s = await tr.schema(projectPath);
      setSchema(s);
      setError(s.ok ? null : s.error || "control schema failed");
      const cutoff = Date.now() - EDIT_HOLD_MS;
      setValues((prev) => {
        const next: Record<string, Record<string, unknown>> = {};
        for (const t of s.targets ?? []) {
          next[t.key] = { ...prev[t.key] };
          for (const p of t.pars) {
            const stamp = editStampRef.current.get(`${t.key}:${p.name}`) ?? 0;
            if (stamp <= cutoff) next[t.key][p.name] = p.value;
          }
        }
        return next;
      });
    } catch (e) {
      setSchema(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath, canUse]);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  // Value poll while the panel is usable and schema loaded without error.
  useEffect(() => {
    if (!projectPath || !canUse || !schema?.ok || error) return;
    const id = window.setInterval(() => {
      pollRef.current += 1;
      if (pollRef.current % SCHEMA_EVERY === 0) {
        void loadSchema();
        return;
      }
      void tr
        .values(projectPath)
        .then((v) => {
          if (!v.ok) return;
          // A response in hand is up to a poll period old — never let it
          // overwrite a par the user just edited (the write queue owns those).
          const cutoff = Date.now() - EDIT_HOLD_MS;
          setValues((prev) => {
            const next = { ...prev };
            for (const t of v.targets) {
              const merged = { ...next[t.key] };
              for (const [name, value] of Object.entries(t.values)) {
                const stamp = editStampRef.current.get(`${t.key}:${name}`) ?? 0;
                if (stamp <= cutoff) merged[name] = value;
              }
              next[t.key] = merged;
            }
            return next;
          });
        })
        .catch((e) => setError(String(e)));
    }, VALUE_POLL_MS);
    return () => window.clearInterval(id);
  }, [projectPath, canUse, schema, error, loadSchema]);

  /** Expose one more COMP remotely, then refresh both schema and candidates. */
  const addComp = useCallback(
    async (compPath: string) => {
      if (!projectPath || !tr.addComp) return;
      try {
        const r = await tr.addComp(projectPath, compPath);
        if (r.ok === false) {
          onStatusMsg(`Expose failed: ${r.error || "refused"}`);
          return;
        }
        onStatusMsg(r.already ? "Already exposed" : `Exposing ${compPath}`);
        await loadSchema();
        if (addOpen) await openCompScan();
      } catch (e) {
        onStatusMsg(String(e));
      }
    },
    [projectPath, tr, onStatusMsg, loadSchema, openCompScan, addOpen],
  );

  /** Stop exposing a sequence-block target (the perform window has no ×). */
  const removeTarget = useCallback(
    async (key: string, name: string) => {
      if (!projectPath || !tr.removeComp) return;
      try {
        const r = await tr.removeComp(projectPath, key);
        if (r.ok === false) {
          onStatusMsg(`Remove failed: ${r.error || "refused"}`);
          return;
        }
        onStatusMsg(`Stopped exposing ${name}`);
        await loadSchema();
        if (addOpen) await openCompScan();
      } catch (e) {
        onStatusMsg(String(e));
      }
    },
    [projectPath, tr, onStatusMsg, loadSchema, openCompScan, addOpen],
  );

  /** Send this target's queued values; at most one write in flight per target,
   * anything queued during the flight goes out in one coalesced trailing send.
   * Ordered writes end the out-of-order snap-back a send-per-event causes. */
  const flushTarget = useCallback(
    (targetKey: string) => {
      if (!projectPath) return;
      if (inflightRef.current.has(targetKey)) return;
      const pend = pendingRef.current.get(targetKey);
      if (!pend || pend.size === 0) return;
      const sets = [...pend.entries()].map(([par, value]) => ({ target: targetKey, par, value }));
      pend.clear();
      inflightRef.current.add(targetKey);
      void tr
        .set(projectPath, sets)
        .then((r) => {
          const bad = (r.results ?? []).filter((x) => !x.ok);
          if (bad.length) onStatusMsg(bad.map((x) => `${x.par}: ${x.error}`).join(" · "));
        })
        .catch((e) => onStatusMsg(String(e)))
        .finally(() => {
          inflightRef.current.delete(targetKey);
          flushTarget(targetKey);
        });
    },
    [projectPath, onStatusMsg],
  );

  const commitMany = useCallback(
    (targetKey: string, sets: { par: string; value: unknown }[]) => {
      if (!projectPath || !sets.length) return;
      const now = Date.now();
      setValues((prev) => ({
        ...prev,
        [targetKey]: {
          ...prev[targetKey],
          ...Object.fromEntries(sets.map((s) => [s.par, s.value])),
        },
      }));
      let pend = pendingRef.current.get(targetKey);
      if (!pend) {
        pend = new Map();
        pendingRef.current.set(targetKey, pend);
      }
      for (const s of sets) {
        pend.set(s.par, s.value);
        editStampRef.current.set(`${targetKey}:${s.par}`, now);
      }
      flushTarget(targetKey);
    },
    [projectPath, flushTarget],
  );

  const commit = useCallback(
    (targetKey: string, par: ControlParDescriptor, value: unknown) => {
      if (!projectPath) return;
      if (par.style === "Pulse") {
        // Pulses fire once per click — never coalesced away in the queue.
        void tr
          .set(projectPath, [{ target: targetKey, par: par.name, value }])
          .then((r) => {
            const item = r.results?.[0];
            if (!r.ok || !item?.ok) {
              onStatusMsg(`${par.name}: ${item?.error || r.error || "write refused"}`);
            }
          })
          .catch((e) => onStatusMsg(String(e)));
        return;
      }
      commitMany(targetKey, [{ par: par.name, value }]);
    },
    [projectPath, onStatusMsg, commitMany],
  );

  // Perform window first — it's the group that matters most in a live show.
  const targets: ControlTarget[] = useMemo(
    () => [...(schema?.targets ?? [])].sort((a, b) => Number(b.builtin) - Number(a.builtin)),
    [schema],
  );
  const nPars = useMemo(() => targets.reduce((n, t) => n + t.pars.length, 0), [targets]);

  const showPins = !!touch;
  const q = filter.trim();

  /** Render one row (single par or ParGroup), wiring pin + touch affordances. */
  const renderRow = (tKey: string, row: ControlParDescriptor | ControlParDescriptor[]) => {
    const pinKey = rowPinKey(tKey, row);
    const pinProps = showPins
      ? { pinned: pins.has(pinKey), onTogglePin: () => togglePin(pinKey) }
      : {};
    return Array.isArray(row) ? (
      <GroupRow
        key={`${tKey}:${row[0].page}:${row[0].tuplet}`}
        pars={row}
        values={values[tKey] ?? {}}
        disabled={!row[0].enabled}
        onCommitMany={(sets) => commitMany(tKey, sets)}
        touch={touch}
        {...pinProps}
      />
    ) : (
      <ParRow
        key={`${tKey}:${row.name}`}
        par={row}
        value={values[tKey]?.[row.name]}
        disabled={!row.enabled}
        onCommit={(v) => commit(tKey, row, v)}
        touch={touch}
        {...pinProps}
      />
    );
  };

  // Per-target rows after search filter, split into pinned (float to the top)
  // and normal. Pinned rows MOVE to the Pinned section rather than duplicate,
  // so there's never two live controls for one par.
  const perTarget = targets.map((t) => {
    const rows = buildRows(t.pars).filter((row) => rowMatches(row, q));
    const pinned = showPins ? rows.filter((row) => pins.has(rowPinKey(t.key, row))) : [];
    const normal = showPins ? rows.filter((row) => !pins.has(rowPinKey(t.key, row))) : rows;
    return { t, pinned, normal };
  });
  const pinnedEntries = perTarget.flatMap(({ t, pinned }) =>
    pinned.map((row) => ({ t, row })),
  );
  const anyVisible =
    pinnedEntries.length > 0 || perTarget.some(({ normal }) => normal.length > 0);

  /** Render one lazily-loaded tree layer — the children of `parent` — with a
   *  twisty on each folder and an Expose action on each COMP that has params.
   *  Expanded folders recurse into their own (separately fetched) layer. */
  const renderLayer = (parent: string, depth: number): React.ReactNode[] => {
    const kids = compChildren[parent];
    if (!kids) return [];
    return kids.flatMap((c) => {
      const open = compExpanded.has(c.path);
      const pad = { paddingLeft: 4 + depth * 14 };
      const rows: React.ReactNode[] = [
        <div key={c.path} className="control-comp-treerow" style={pad}>
          {c.has_children ? (
            <button
              type="button"
              className="control-comp-twisty"
              title={open ? "Collapse" : "Expand"}
              onClick={() => toggleExpand(c.path)}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="control-comp-twisty spacer" />
          )}
          {c.pars > 0 ? (
            <button
              type="button"
              className="control-comp-node"
              disabled={c.added}
              title={c.added ? "Already exposed" : `Expose ${c.path}`}
              onClick={() => void addComp(c.path)}
            >
              <span className="control-comp-name">{c.name}</span>
              <span className="tag-hint">{c.added ? "exposed" : `${c.pars} par`}</span>
            </button>
          ) : (
            <button
              type="button"
              className="control-comp-node folder"
              title={c.path}
              onClick={() => c.has_children && toggleExpand(c.path)}
            >
              <span className="control-comp-name">{c.name}</span>
            </button>
          )}
        </div>,
      ];
      if (open) {
        if (!compChildren[c.path] && compLoading.has(c.path)) {
          rows.push(
            <div
              key={`${c.path}::loading`}
              className="tag-hint"
              style={{ paddingLeft: 4 + (depth + 1) * 14 }}
            >
              Scanning…
            </div>,
          );
        } else {
          rows.push(...renderLayer(c.path, depth + 1));
        }
      }
      return rows;
    });
  };

  return (
    <div className="right-col control-side">
      <div className="readme-header git-side-header">
        <strong>Control</strong>
        <span className="git-summary-chip">
          {projectPath
            ? `${basename(projectPath)}${schema?.ok ? ` · ${targets.length} comp / ${nPars} par` : ""}`
            : "—"}
        </span>
        {onPhoneRemote && (
          <button
            type="button"
            className="small ghost"
            title="Pair a phone over Wi-Fi — scan a QR to open this on your phone"
            onClick={onPhoneRemote}
          >
            📱 Phone
          </button>
        )}
        {onOpenBrowser && (
          <button
            type="button"
            className="small ghost"
            title="Open this control panel in the default browser"
            onClick={onOpenBrowser}
          >
            Browser
          </button>
        )}
        <button
          type="button"
          className="small ghost"
          disabled={loading || !canUse}
          onClick={() => void loadSchema()}
        >
          Refresh
        </button>
      </div>

      {!canUse && (
        <div className="git-side-empty subtle">Select a running session to control</div>
      )}

      {canUse && error && (
        <div className="git-side-empty subtle">
          {error}
          <div className="tag-hint">
            The session needs the companion utility with a configured Control page.
          </div>
        </div>
      )}

      {canUse && !error && schema?.ok && targets.length === 0 && (
        <div className="git-side-empty subtle">
          No parameters exposed. On the utility COMP's Control page, point a sequence
          block at a COMP (page/name filters optional) or enable Expose Perform Window.
        </div>
      )}

      {touch && canUse && !error && schema?.ok && targets.length > 0 && (
        <div className="control-search">
          <input
            type="search"
            inputMode="search"
            placeholder="Filter parameters…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button type="button" className="small ghost" onClick={() => setFilter("")}>
              Clear
            </button>
          )}
        </div>
      )}

      {canUse && !error && schema?.ok && targets.length > 0 && !anyVisible && (
        <div className="git-side-empty subtle">No parameters match "{q}".</div>
      )}

      {canUse && !error && showPins && pinnedEntries.length > 0 && (
        <div className="control-target control-pinned">
          <div className="git-changes-head">
            <span className="control-target-toggle">★ Pinned</span>
            <span className="tag-hint">{pinnedEntries.length}</span>
          </div>
          <div className="control-par-list">
            {pinnedEntries.map(({ t, row }) => renderRow(t.key, row))}
          </div>
        </div>
      )}

      {canUse &&
        !error &&
        perTarget.map(({ t, normal }) => {
          if (normal.length === 0) return null;
          // While filtering, force groups open so matches aren't hidden.
          const open = q ? true : !collapsed[t.key];
          // Par count of the visible rows (groups count all components), so the
          // badge stays "N params" — identical to before on the desktop.
          const parCount = normal.reduce(
            (n, row) => n + (Array.isArray(row) ? row.length : 1),
            0,
          );
          return (
            <div key={t.key} className="control-target">
              <div className="git-changes-head">
                <button
                  type="button"
                  className="control-target-toggle"
                  onClick={() => setCollapsed((c) => ({ ...c, [t.key]: open }))}
                  title={t.path}
                >
                  {open ? "▾" : "▸"} {t.name}
                  {t.builtin && t.name.toLowerCase() !== "perform" ? (
                    <span className="tag-hint"> · perform window</span>
                  ) : null}
                </button>
                <span className="tag-hint">{parCount}</span>
                {!t.builtin &&
                  tr.removeComp &&
                  (confirmRemove === t.key ? (
                    <span className="control-target-confirm">
                      <button
                        type="button"
                        className="control-target-remove danger"
                        title={`Stop exposing ${t.name} — removes its Control block`}
                        onClick={() => {
                          setConfirmRemove(null);
                          void removeTarget(t.key, t.name);
                        }}
                      >
                        Remove?
                      </button>
                      <button
                        type="button"
                        className="control-target-remove"
                        title="Keep it"
                        onClick={() => setConfirmRemove(null)}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="control-target-remove"
                      title={`Stop exposing ${t.name} (removes its Control block)`}
                      onClick={() => setConfirmRemove(t.key)}
                    >
                      ×
                    </button>
                  ))}
              </div>
              {open &&
                (() => {
                  const pages = groupByPage(normal);
                  // One page, or filtering (matches may span pages): flat list.
                  if (pages.length <= 1 || q) {
                    return (
                      <div className="control-par-list">
                        {normal.map((row) => renderRow(t.key, row))}
                      </div>
                    );
                  }
                  // Multiple pages: tabs like the COMP's own parameter dialog.
                  const names = pages.map((p) => p.page);
                  const active = names.includes(activePage[t.key] ?? "")
                    ? activePage[t.key]
                    : names[0];
                  const activeRows = pages.find((p) => p.page === active)?.rows ?? [];
                  return (
                    <>
                      <div className="control-page-tabs" role="tablist">
                        {pages.map(({ page, rows }) => (
                          <button
                            key={page || "_"}
                            type="button"
                            role="tab"
                            aria-selected={page === active}
                            className={`control-page-tab ${page === active ? "active" : ""}`}
                            title={`${rows.length} parameter${rows.length === 1 ? "" : "s"}`}
                            onClick={() => setActivePage((m) => ({ ...m, [t.key]: page }))}
                          >
                            {page || "Parameters"}
                          </button>
                        ))}
                      </div>
                      <div className="control-par-list">
                        {activeRows.map((row) => renderRow(t.key, row))}
                      </div>
                    </>
                  );
                })()}
            </div>
          );
        })}

      {canUse && !error && schema?.ok && tr.comps && tr.addComp && (
        <div className="control-add">
          <button
            type="button"
            className="small ghost control-add-toggle"
            title="List components with custom parameters and expose one on the companion's Control page"
            onClick={() => {
              const opening = !addOpen;
              setAddOpen(opening);
              // Scan the top layer on open — lazy, live; deeper layers load as
              // folders expand. The last traversal is restored from storage.
              if (opening) void openCompScan();
            }}
          >
            {addOpen ? "▾ Expose a component" : "＋ Expose a component"}
          </button>
          {addOpen && (
            <div className="control-comp-list">
              {compsErr ? (
                <div className="tag-hint">{compsErr}</div>
              ) : !compRootLoaded ? (
                <div className="tag-hint">Scanning components…</div>
              ) : (compChildren[""]?.length ?? 0) === 0 ? (
                <div className="tag-hint">
                  No components with custom parameters found near root.
                </div>
              ) : (
                renderLayer("", 0)
              )}
            </div>
          )}
        </div>
      )}

      <div className="backup-footnote tag-hint">
        Mirrors the Control page of the session's companion utility. Writes only touch
        parameters the schema exposes; expression-driven parameters are read-only.
      </div>
    </div>
  );
}

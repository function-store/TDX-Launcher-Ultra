import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { mediaSrc, previewKind } from "./mediaSrc";
import type {
  MediaListReply,
  MediaProbeReply,
  MediaRef,
  MediaUnreferencedReply,
} from "./types";

type Props = {
  /** .toe path of the running session to inspect; null when none is selected. */
  sessionPath: string | null;
  /** False when the selected row has no reachable companion. */
  canUse: boolean;
  onStatusMsg: (msg: string) => void;
  /**
   * Blessed fns.media-browser command keys by legacy verb name (capability
   * injection — docs/fns-plus-capabilities.md D6). When the session
   * advertises the capability, the panel drives it through
   * `fns_run_command` on these keys; absent/null falls back to the bespoke
   * `media_*` bus verbs (old companion), which keep working through the
   * D7 deprecation window.
   */
  commandKeys?: Record<string, string> | null;
};

const CATEGORY_ORDER = ["video", "image", "audio", "geometry"] as const;

function formatBytes(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

/** Last two path segments — enough to tell two sibling operators apart. */
function shortOp(opPath: string): string {
  return opPath.split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * One line of probed facts, or null when there is nothing worth a line.
 * A still loaded through a Movie File In reports kind "movie" with a single
 * frame — duration and fps are noise there, so they only appear for real
 * clips. No codec: TD exposes none.
 */
function probeFacts(p: MediaProbeReply | undefined): string | null {
  if (!p?.ok) return null;
  if (p.kind === "movie") {
    const bits = [`${p.resx}×${p.resy}`];
    if ((p.frames ?? 0) > 1) {
      bits.push(
        (p.seconds != null ? `${p.seconds}s` : `${p.frames} frames`) +
          ` @ ${p.fps} fps`,
      );
      if (p.has_audio) bits.push("audio");
    }
    return bits.join(" · ");
  }
  if (p.kind === "image") return `${p.resx}×${p.resy}`;
  if (p.kind === "audio") {
    const bits = [`${p.channels} ch`];
    if (p.seconds != null) bits.push(`${p.seconds}s`);
    return bits.join(" · ");
  }
  return null;
}

/**
 * Session inspector panel: every media file reference in the running project,
 * with a preview of the selected one and a Replace action.
 *
 * Previews cover only what the WebView decodes. TouchDesigner reads far more
 * (tif, exr, dds, hdr, dpx, mxf, and every geometry format), so anything
 * outside that subset gets an explicit "no preview" note rather than a broken
 * element — see previewKind() and is_allowed_media in media_stream.rs.
 *
 * Nothing here copies files or saves the project: a replacement lands in the
 * running session only, the same contract Repoint keeps.
 */
export default function MediaPanel({
  sessionPath,
  canUse,
  onStatusMsg,
  commandKeys,
}: Props) {
  const [reply, setReply] = useState<MediaListReply | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped after a replace: same ref, different bytes, so the URL alone
  // cannot tell the WebView to refetch.
  const [version, setVersion] = useState(0);
  // Probed facts per ref for THIS scan. The companion caches by value too, so
  // this only avoids the round-trip; a rescan clears it.
  const [probes, setProbes] = useState<Record<string, MediaProbeReply>>({});
  // The unused-on-disk sweep is a folder walk — fetched only while its
  // section is open, never as part of the ordinary scan.
  const [unref, setUnref] = useState<MediaUnreferencedReply | null>(null);
  const [unrefOpen, setUnrefOpen] = useState(false);

  // One transport for every media verb: the blessed command rail when the
  // session advertises fns.media-browser, the legacy bus verb otherwise.
  // Payload keys double as the tool method's kwargs (ref / path / timeline /
  // subfolder), so both paths ship the same JSON and reply the same shape.
  const runMedia = useCallback(
    (action: string, payload?: Record<string, unknown> | null): Promise<unknown> => {
      if (!sessionPath) return Promise.resolve(null);
      // Capability-only since D7: the media browser left the companion, so
      // there is no legacy verb left to fall back to. No keys = the package
      // is not installed in this session.
      const key = commandKeys?.[action];
      if (!key) {
        return Promise.resolve({
          ok: false,
          error:
            "The media browser ships as the MediaBrowser package — install it from the FNSTools tab",
        });
      }
      return api.openProjectUtility(sessionPath, "fns_run_command", {
        key,
        ...(payload ? { kwargs: payload } : {}),
      });
    },
    [sessionPath, commandKeys],
  );

  const scan = useCallback(
    async (quiet = false) => {
      if (!sessionPath || !canUse) {
        setReply(null);
        return;
      }
      setBusy(true);
      try {
        const result = (await runMedia("media_list", null)) as MediaListReply | null;
        const next = result ?? {};
        if (!next.ok) {
          setReply(null);
          if (!quiet) onStatusMsg(`Media scan failed: ${next.error ?? "failed"}`);
          return;
        }
        setReply(next);
        setProbes({});
        setUnref(null);
        setSelectedRef((prev) =>
          prev && next.refs?.some((r) => r.ref === prev)
            ? prev
            : (next.refs?.[0]?.ref ?? null),
        );
        if (!quiet) {
          onStatusMsg(
            `${next.count ?? 0} media reference(s)` +
              (next.missing ? `, ${next.missing} missing` : ""),
          );
        }
      } catch (e) {
        if (!quiet) onStatusMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [sessionPath, canUse, onStatusMsg, runMedia],
  );

  // Re-scan when the panel points at a different session. Quiet, so opening
  // the panel does not stamp over whatever the status bar was showing.
  useEffect(() => {
    void scan(true);
  }, [scan]);

  const refs = reply?.refs ?? [];
  const visible = missingOnly
    ? refs.filter((r) => !r.exists && !r.sequence)
    : refs;
  const selected =
    visible.find((r) => r.ref === selectedRef) ?? visible[0] ?? null;

  // Probe lazily, one ref at a time, only when a resolvable row is selected —
  // never the whole list up front (each movie probe force-cooks an Info CHOP
  // in the session).
  useEffect(() => {
    const sel = selected;
    if (!sessionPath || !sel || sel.sequence || sel.exists === false) return;
    if (probes[sel.ref]) return;
    let gone = false;
    void (async () => {
      try {
        const r = (await runMedia("media_probe", {
          ref: sel.ref,
        })) as MediaProbeReply | null;
        if (!gone && r?.ok) setProbes((p) => ({ ...p, [sel.ref]: r }));
      } catch {
        // Facts line is a bonus — a failed probe just leaves it absent.
      }
    })();
    return () => {
      gone = true;
    };
  }, [sessionPath, selected, probes, runMedia]);

  const loadUnref = useCallback(async () => {
    if (!sessionPath) return;
    try {
      const r = (await runMedia("media_unreferenced", null)) as MediaUnreferencedReply | null;
      if (r?.ok) setUnref(r);
      else onStatusMsg(`Unused-media scan failed: ${r?.error ?? "failed"}`);
    } catch (e) {
      onStatusMsg(String(e));
    }
  }, [sessionPath, onStatusMsg, runMedia]);

  /**
   * Batch relink: the user points at where the missing files actually live
   * (a moved drive, a restored backup), each missing name is looked up under
   * that folder, and every hit goes through the same media_replace path as a
   * single Replace. Locked refs are left alone — they cannot be rewritten.
   */
  const locateMissing = async () => {
    if (!sessionPath) return;
    const missing = refs.filter((r) => !r.exists && !r.sequence && !r.locked);
    if (missing.length === 0) return;
    try {
      const folder = await api.pickFolder("Locate missing media");
      if (!folder) return;
      setBusy(true);
      const names = Array.from(new Set(missing.map((r) => r.name)));
      const found = await api.locateMediaFiles(folder, names);
      let relinked = 0;
      let failed = 0;
      for (const r of missing) {
        const path = found[r.name];
        if (!path) continue;
        const res = (await runMedia("media_replace", {
          ref: r.ref,
          path,
        })) as { ok?: boolean } | null;
        if (res?.ok) relinked += 1;
        else failed += 1;
      }
      const unmatched = names.filter((n) => !found[n]).length;
      onStatusMsg(
        relinked
          ? `Relinked ${relinked} of ${missing.length} missing reference(s)` +
              (unmatched ? `; ${unmatched} name(s) not found there` : "") +
              (failed ? `; ${failed} failed` : "") +
              " — not saved"
          : `None of the ${names.length} missing name(s) found under that folder`,
      );
      if (relinked) {
        setVersion((v) => v + 1);
        await scan(true);
      }
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Movie/audio clips can size the timeline; stills and geometry cannot. */
  const syncable = (r: MediaRef) =>
    (r.category === "video" || r.category === "audio") &&
    (r.optype === "moviefileinTOP" || r.optype === "audiofileinCHOP") &&
    r.exists !== false;

  const syncTimeline = async (row: MediaRef, timeline: "local" | "global") => {
    if (!sessionPath) return;
    setBusy(true);
    try {
      const result = (await runMedia("media_sync", {
        ref: row.ref,
        timeline,
      })) as {
        ok?: boolean;
        error?: string;
        frames?: number;
        rate?: number;
        seconds?: number;
        timeline?: string;
        timeline_scope?: string;
      } | null;
      if (!result?.ok) {
        onStatusMsg(`Sync failed: ${result?.error ?? "failed"}`);
        return;
      }
      const scope = result.timeline_scope ?? timeline;
      onStatusMsg(
        `${scope === "global" ? "Global" : "Local"} timeline synced to ${row.name}: ` +
          `${result.frames} frames @ ${result.rate} fps` +
          (result.seconds != null ? ` (${result.seconds}s)` : "") +
          " — not saved",
      );
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const replace = async (row: MediaRef) => {
    if (!sessionPath) return;
    try {
      const picked = await api.pickMediaFile(row.category);
      if (!picked) return;
      setBusy(true);
      const result = (await runMedia("media_replace", {
        ref: row.ref,
        path: picked,
      })) as { ok?: boolean; error?: string; value?: string } | null;
      if (!result?.ok) {
        onStatusMsg(`Replace failed: ${result?.error ?? "failed"}`);
        return;
      }
      setVersion((v) => v + 1);
      onStatusMsg(`${row.op}.${row.par} → ${result.value ?? picked} (not saved)`);
      await scan(true);
    } catch (e) {
      onStatusMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!canUse) {
    return (
      <div className="right-col watch-side media-side">
        <div className="readme-header git-side-header media-side-head">
          <strong>Media</strong>
        </div>
        <p className="hint">
          Select a running session with the companion loaded to browse its media
          references.
        </p>
      </div>
    );
  }

  const kind = selected ? previewKind(selected.file || selected.name) : null;
  const ext = (selected?.name.split(".").pop() ?? "").toUpperCase();
  const gone = !!selected && !selected.exists && !selected.sequence;

  return (
    <div className="right-col watch-side media-side">
      <div className="readme-header git-side-header media-side-head">
        <strong>Media</strong>
        <span className="git-summary-chip">
          {reply
            ? `${reply.count ?? 0} ref(s)` +
              (reply.missing ? ` · ${reply.missing} missing` : "")
            : "—"}
        </span>
        <label
          className="check"
          title="Show only references whose file is missing on disk"
        >
          <input
            type="checkbox"
            checked={missingOnly}
            onChange={(e) => setMissingOnly(e.target.checked)}
          />
          Missing only
        </label>
        {(reply?.missing ?? 0) > 0 && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => void locateMissing()}
            title="Pick the folder the missing files actually live in — every missing reference whose filename is found there is relinked (not saved)"
          >
            Locate missing…
          </button>
        )}
        <button
          type="button"
          className="small ghost"
          disabled={busy}
          onClick={() => {
            const next = !unrefOpen;
            setUnrefOpen(next);
            if (next && !unref) void loadUnref();
          }}
          title="Media files on disk in the project folder that no operator references — dead weight a backup or collect would ship"
        >
          {unrefOpen ? "Hide unused" : "Unused…"}
        </button>
        <button
          type="button"
          className="small ghost"
          disabled={busy}
          onClick={() => void scan()}
          title="Re-scan the session for media references"
        >
          Rescan
        </button>
      </div>

      {unrefOpen && (
        <div className="media-panel-list media-panel-unref">
          <div className="media-panel-group">
            {unref
              ? `unused on disk — ${unref.count ?? 0} file(s), ${formatBytes(
                  unref.total_bytes,
                )}`
              : "unused on disk — scanning…"}
          </div>
          {(unref?.unreadable_pars ?? 0) > 0 && (
            <p className="hint">
              {unref?.unreadable_pars} parameter(s) could not be read (broken
              expressions) — files only they reference may wrongly appear
              here.
            </p>
          )}
          {unref?.truncated && (
            <p className="hint">
              Project folder is very large — this list is incomplete.
            </p>
          )}
          {(unref?.files ?? []).map((f) => (
            <div
              key={f.rel}
              className="media-panel-row is-static"
              title={f.file}
            >
              <span className="media-panel-name">{f.name}</span>
              <span className="media-panel-op">{f.rel}</span>
              <span className="media-panel-size">{formatBytes(f.bytes)}</span>
            </div>
          ))}
          {unref && (unref.files?.length ?? 0) === 0 && (
            <p className="hint">Every media file on disk is referenced.</p>
          )}
        </div>
      )}

      <div className="media-panel-list">
        {CATEGORY_ORDER.map((cat) => ({
          cat,
          rows: visible.filter((r) => r.category === cat),
        }))
          .filter((g) => g.rows.length > 0)
          .map(({ cat, rows }) => (
            <div key={cat}>
              <div className="media-panel-group">{cat}</div>
              {rows.map((r) => {
                const rowGone = !r.exists && !r.sequence;
                return (
                  <button
                    key={r.ref}
                    type="button"
                    className={
                      "media-panel-row" +
                      (r.ref === selected?.ref ? " is-selected" : "") +
                      (rowGone ? " is-missing" : "")
                    }
                    title={`${r.value}\n${r.op}.${r.par}${
                      r.locked ? `\nLocked: ${r.locked}` : "\n\nDouble-click to replace the file"
                    }`}
                    onClick={() => setSelectedRef(r.ref)}
                    // Single click selects (it drives the preview and the
                    // timeline actions), so replacing is the double click —
                    // the same gesture that opens a file everywhere else.
                    onDoubleClick={() => {
                      setSelectedRef(r.ref);
                      if (!r.locked) void replace(r);
                    }}
                  >
                    <span className="media-panel-name">{r.name}</span>
                    <span className="media-panel-op">
                      {shortOp(r.op)}.{r.par}
                    </span>
                    <span className="media-panel-size">
                      {r.sequence
                        ? "seq"
                        : rowGone
                          ? "missing"
                          : formatBytes(r.bytes)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        {visible.length === 0 && (
          <p className="hint">
            {refs.length === 0
              ? "No media references in this project."
              : "No missing references — every file resolves."}
          </p>
        )}
      </div>

      {selected && (
        <div className="media-panel-preview">
          {gone ? (
            <div className="media-panel-nopreview">
              File is missing on disk.
              <span>{selected.value}</span>
            </div>
          ) : selected.sequence ? (
            <div className="media-panel-nopreview">
              Sequence pattern — no single file to preview.
              <span>{selected.value}</span>
            </div>
          ) : kind === "image" ? (
            <img src={mediaSrc(selected.file, "image", version)} alt={selected.name} />
          ) : kind === "video" ? (
            <video
              key={`${selected.ref}-${version}`}
              src={mediaSrc(selected.file, "video", version)}
              controls
            />
          ) : kind === "audio" ? (
            <audio
              key={`${selected.ref}-${version}`}
              src={mediaSrc(selected.file, "audio", version)}
              controls
            />
          ) : (
            // Honest rather than a broken <img>: TD decodes this, the WebView
            // does not. Open it in TD to see it.
            <div className="media-panel-nopreview">
              No preview — {ext || "this file"} isn’t a format this app can
              display.
              <span>{selected.value}</span>
            </div>
          )}
          {probeFacts(probes[selected.ref]) && (
            <div className="media-panel-facts">
              {probeFacts(probes[selected.ref])}
            </div>
          )}
          <div className="media-panel-actions">
            <button
              type="button"
              className="small"
              disabled={busy || !!selected.locked}
              title={
                selected.locked
                  ? `Cannot replace: ${selected.locked}`
                  : "Point this parameter at a different file (not saved)"
              }
              onClick={() => void replace(selected)}
            >
              Replace…
            </button>
            {syncable(selected) &&
              (selected.local_timeline ? (
                // The op runs on its own Time COMP, so there are two
                // candidate timelines — surface the choice instead of
                // guessing which one the user means.
                <>
                  <button
                    type="button"
                    className="small"
                    disabled={busy}
                    title={`Stretch this clip's own timeline (${selected.local_timeline}) — the clock that drives it — to exactly fit the clip, and lock playback to it (not saved)`}
                    onClick={() => void syncTimeline(selected, "local")}
                  >
                    Sync local timeline
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={busy}
                    title="Stretch the root (global) timeline to exactly fit this clip. The clip itself stays driven by its local clock (not saved)"
                    onClick={() => void syncTimeline(selected, "global")}
                  >
                    Sync global
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  title="Stretch the session's timeline to exactly fit this clip and lock its playback to the timeline (not saved)"
                  onClick={() => void syncTimeline(selected, "local")}
                >
                  Sync timeline
                </button>
              ))}
            {selected.locked && <span className="hint">{selected.locked}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

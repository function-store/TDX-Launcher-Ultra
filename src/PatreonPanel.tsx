import { type DragEvent, type MouseEvent, useEffect, useMemo, useState } from "react";
import type {
  ListItem,
  PatreonCampaign,
  PatreonSearchHit,
  PatreonToxFile,
  PatreonToxPost,
  PatreonZipExtract,
} from "./types";
import type { PatreonCampaignSort, PatreonCampaignView } from "./uiPersist";
import { PatreonTrustNotice, PatreonUnofficialNote } from "./patreonCopy";

type SortKey = "newest" | "oldest" | "name" | "type";

/**
 * A file the user can drag into a TouchDesigner network: either a Patreon
 * attachment identified by its download `url`, or an already-local file
 * (a `.tox` pulled out of an extracted zip) identified by `path`.
 */
export type PatreonDragFile = {
  name: string;
  url?: string;
  path?: string;
  /** Creator to file the download under. Needed for a cross-creator cache
   *  hit, where no creator is open to infer it from. */
  campaign?: string;
};

/**
 * The `.tox` a whole post stands for — its first one, which is what dragging
 * the post card drops. Locked posts have nothing we're allowed to fetch.
 */
function firstToxFile(post: PatreonToxPost): PatreonToxFile | undefined {
  return post.canView ? post.toxFiles.find((f) => f.kind === "tox") : undefined;
}

/**
 * The `.toe` a whole post stands for — what double-clicking the post card
 * opens, mirroring the double-click-to-launch idiom in Recent Files. Locked
 * posts have nothing we're allowed to fetch.
 */
function firstToeFile(post: PatreonToxPost): PatreonToxFile | undefined {
  return post.canView ? post.toxFiles.find((f) => f.kind === "toe") : undefined;
}

/**
 * What double-clicking a post card runs: its first `.toe` (open it), else its
 * first `.zip` (unzip it, which surfaces whatever `.tox`/`.toe` is inside as
 * its own rows). `.tox` is deliberately absent — that one is the drag gesture,
 * and its button loads into a LIVE session, which is not something a stray
 * double-click should do mid-show.
 */
function postOpenAction(
  post: PatreonToxPost,
): { kind: "toe" | "zip"; file: PatreonToxFile } | undefined {
  const toe = firstToeFile(post);
  if (toe) return { kind: "toe", file: toe };
  const zip = post.canView ? post.toxFiles.find((f) => f.kind === "zip") : undefined;
  return zip ? { kind: "zip", file: zip } : undefined;
}

/**
 * Drag handle. Always rendered so rows stay aligned; `active` false just
 * hides it (a post with no `.tox`, or a `.toe`/`.zip` row TD can't take).
 */
function DragGrip({ active }: { active: boolean }) {
  return (
    <span
      className={active ? "patreon-drag-grip" : "patreon-drag-grip patreon-drag-grip-off"}
      aria-hidden="true"
    >
      ⠿
    </span>
  );
}

/** Type rank: tox+toe first, then tox-only, then toe-only, then zip-only. */
function typeRank(p: PatreonToxPost): number {
  const set = new Set(p.toxFiles.map((f) => f.kind));
  const hasTox = set.has("tox");
  const hasToe = set.has("toe");
  const hasZip = set.has("zip");
  if (hasTox && hasToe) return 0;
  if (hasTox) return 1;
  if (hasToe) return 2;
  if (hasZip) return 3;
  return 4;
}

/** Case-insensitive, all-terms substring match — for the toolbar Search box. */
function matchText(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = text.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * A post matches on its attachment filenames as well as its title — the name
 * on the .tox is what people remember, and creators rarely repeat it in the
 * post title ("New patron component!" hides `God_Rays.tox`).
 */
function matchPost(post: PatreonToxPost, query: string): boolean {
  return matchText(`${post.title} ${post.toxFiles.map((f) => f.name).join(" ")}`, query);
}

/**
 * Creator list sort — "latest" needs `dateById`, fetched lazily (see App.tsx).
 * Depending on the "TD files only" filter, that's either the campaign's
 * single most recent post (cheap, default) or its most recent file-bearing
 * one (expensive, opt-in) — the caller decides which map to pass in.
 */
function sortCampaigns(
  campaigns: PatreonCampaign[],
  key: PatreonCampaignSort,
  dateById: Record<string, string | null | undefined>,
): PatreonCampaign[] {
  const out = [...campaigns];
  out.sort((a, b) => {
    // The featured creator stays on top whatever the sort.
    if (!!a.featured !== !!b.featured) return a.featured ? -1 : 1;
    if (key === "latest") {
      const av = dateById[a.id];
      const bv = dateById[b.id];
      if (av && bv) return bv.localeCompare(av);
      if (av) return -1;
      if (bv) return 1;
      // Unknown/no recent upload on both sides — fall back to name.
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return out;
}

function sortPosts(posts: PatreonToxPost[], key: SortKey): PatreonToxPost[] {
  const out = [...posts];
  const newestFirst = (a: PatreonToxPost, b: PatreonToxPost) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  out.sort((a, b) => {
    switch (key) {
      case "name":
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      case "type":
        // Both-kinds first, then newest within each group.
        return typeRank(a) - typeRank(b) || newestFirst(a, b);
      case "oldest":
        // Oldest first; undated sink to the bottom (￿ sorts last).
        return (a.publishedAt ?? "￿").localeCompare(b.publishedAt ?? "￿");
      case "newest":
      default:
        return newestFirst(a, b);
    }
  });
  return out;
}

/** Explains why the (search + filter)-narrowed posts list came up empty. */
function emptyPostsMessage(search: string, filesOnly: boolean, hideLocked: boolean): string {
  if (search.trim()) return `No posts match "${search.trim()}".`;
  if (filesOnly && hideLocked) return "No unlocked posts have a .tox/.toe/.zip attached.";
  if (filesOnly) return "No posts have a .tox/.toe/.zip attached.";
  if (hideLocked) return "No unlocked posts found.";
  return "No posts found for this creator.";
}

/**
 * Patreon tab — LEFT pane: pick a creator, then a post. The post detail
 * (text + embedded video + file actions) renders in the right stack via
 * {@link PatreonDetail}, so it gets real width.
 *
 * Cookie-based access to Patreon's private web API (official OAuth can't reach
 * patron content). Unofficial + build-gated; the disclaimer stays visible.
 */
export default function PatreonPanel({
  hasCookie,
  loading,
  error,
  campaigns,
  campaign,
  posts,
  selectedPostId,
  search,
  campaignSort,
  onCampaignSortChange,
  campaignView,
  onCampaignViewChange,
  campaignDateByCampaign,
  onRequestCampaignDates,
  campaignFilesOnly,
  onCampaignFilesOnlyChange,
  postsFilesOnly,
  onPostsFilesOnlyChange,
  postsHideLocked,
  onPostsHideLockedChange,
  onReload,
  onSelectCampaign,
  onBackToCampaigns,
  onSelectPost,
  onDragTox,
  onPrimeDragTox,
  onOpenToe,
  onUnzip,
  onOpenUrl,
  onOpenSettings,
  onAddCreator,
  onRemoveCreator,
  cacheHits,
  cacheSearching,
  cachedCreators,
  onOpenHit,
  trustAck,
  onDismissTrust,
}: {
  hasCookie: boolean;
  loading: boolean;
  error: string;
  campaigns: PatreonCampaign[];
  campaign: PatreonCampaign | null;
  posts: PatreonToxPost[];
  selectedPostId: string | null;
  search: string;
  campaignSort: PatreonCampaignSort;
  onCampaignSortChange: (key: PatreonCampaignSort) => void;
  campaignView: PatreonCampaignView;
  onCampaignViewChange: (view: PatreonCampaignView) => void;
  /** Either "latest post" (cheap, default) or "latest upload" (expensive) dates — App.tsx picks which based on campaignFilesOnly. */
  campaignDateByCampaign: Record<string, string | null | undefined>;
  onRequestCampaignDates: () => void;
  /** When true, hide creators with no known .tox/.toe/.zip post, and switch "Latest" to the file-aware (expensive) date. Default: false. */
  campaignFilesOnly: boolean;
  onCampaignFilesOnlyChange: (filesOnly: boolean) => void;
  /** When true, hide posts with no .tox/.toe/.zip attachment. Default: false (show all). */
  postsFilesOnly: boolean;
  onPostsFilesOnlyChange: (filesOnly: boolean) => void;
  /** When true, hide posts the user's tier can't view. Default: false (show all, including locked). */
  postsHideLocked: boolean;
  onPostsHideLockedChange: (hideLocked: boolean) => void;
  onReload: () => void;
  onSelectCampaign: (c: PatreonCampaign) => void;
  onBackToCampaigns: () => void;
  onSelectPost: (id: string) => void;
  /** Start an OS drag of a post's/file's `.tox`, downloading it first if needed. */
  onDragTox: (file: PatreonDragFile, e: DragEvent<HTMLElement>) => void;
  /** Mousedown warm-up: resolve the local path before the drag actually starts. */
  onPrimeDragTox: (file: PatreonDragFile) => void;
  /** Download a `.toe` and hand it to Recent Files — what double-click runs. */
  onOpenToe: (file: { name: string; url: string }) => void;
  /** Download + extract a `.zip` — double-click's action on a zip-only post. */
  onUnzip: (file: { name: string; url: string }) => void;
  /** Open a URL in the OS default browser — a locked post's row click. */
  onOpenUrl: (url: string) => void;
  /** Open Settings on a named section (a `data-settings-section` id in App.tsx). */
  onOpenSettings: (section?: string) => void;
  /** Resolve a pasted creator URL and add it to the list. Rejects with a message. */
  onAddCreator: (url: string) => Promise<void>;
  onRemoveCreator: (c: PatreonCampaign) => void;
  /** Cross-creator name matches for the current search — see {@link CacheHitList}. */
  cacheHits: PatreonSearchHit[];
  cacheSearching: boolean;
  /** Creators whose listing has ever been cached; 0 means nothing to search yet. */
  cachedCreators: number;
  /** Jump to the post a hit came from. */
  onOpenHit: (hit: PatreonSearchHit) => void;
  /** True once the user dismissed the "a .tox runs its creator's code" banner
   *  (the `patreon_trust_ack` pref — shared with the in-TD palette page). */
  trustAck: boolean;
  onDismissTrust: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [creatorUrl, setCreatorUrl] = useState("");
  const [addingCreator, setAddingCreator] = useState(false);
  const [addError, setAddError] = useState("");

  const submitCreator = async () => {
    const url = creatorUrl.trim();
    if (!url || addingCreator) return;
    setAddingCreator(true);
    setAddError("");
    try {
      await onAddCreator(url);
      setCreatorUrl("");
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddingCreator(false);
    }
  };
  const sortedPosts = useMemo(
    () =>
      sortPosts(
        posts.filter(
          (p) =>
            matchPost(p, search) &&
            (!postsFilesOnly || p.toxFiles.length > 0) &&
            (!postsHideLocked || p.canView),
        ),
        sortKey,
      ),
    [posts, sortKey, search, postsFilesOnly, postsHideLocked],
  );
  // Up/Down walk the posts in the order they're shown (search, sort and the
  // two filters applied). Selection only: a locked post opens the browser on
  // CLICK, never while arrowing past it. Typing in a field keeps its keys.
  useEffect(() => {
    if (!campaign || sortedPosts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      e.preventDefault();
      const idx = sortedPosts.findIndex((p) => p.id === selectedPostId);
      const next =
        e.key === "ArrowDown"
          ? Math.min(sortedPosts.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      const id = sortedPosts[next]?.id;
      if (id && id !== selectedPostId) {
        onSelectPost(id);
        document
          .querySelector(`[data-post-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [campaign, sortedPosts, selectedPostId, onSelectPost]);

  const shownCampaigns = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          matchText(c.name, search) &&
          // Hide only once resolved to "no file post found" — while a date
          // is still loading (undefined) keep the creator visible so the
          // list doesn't flash-then-shrink as lookups trickle in.
          (!campaignFilesOnly || campaignDateByCampaign[c.id] !== null),
      ),
    [campaigns, search, campaignFilesOnly, campaignDateByCampaign],
  );
  const sortedCampaigns = useMemo(
    () => sortCampaigns(shownCampaigns, campaignSort, campaignDateByCampaign),
    [shownCampaigns, campaignSort, campaignDateByCampaign],
  );
  // "Latest" sort, the denser list view, and the "TD files only" filter all
  // need per-campaign dates that aren't in the initial campaigns fetch —
  // pull them lazily (cheap "any post" by default, expensive file-aware
  // scan only while campaignFilesOnly is on — see App.tsx).
  useEffect(() => {
    if (
      !campaign &&
      campaigns.length > 0 &&
      (campaignSort === "latest" || campaignView === "list" || campaignFilesOnly)
    ) {
      onRequestCampaignDates();
    }
  }, [campaign, campaigns.length, campaignSort, campaignView, campaignFilesOnly, onRequestCampaignDates]);

  if (!hasCookie) {
    return (
      <div className="panel patreon-panel">
        <div className="patreon-empty">
          <h3>Connect Patreon</h3>
          <p>
            Log in — or paste your Patreon <code>session_id</code> cookie — in Settings to browse{" "}
            <code>.tox</code> / <code>.toe</code> files from creators you support.
          </p>
          <PatreonUnofficialNote className="patreon-disclaimer" />
          <button type="button" className="primary" onClick={() => onOpenSettings("patreon")}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel patreon-panel">
      <div className="patreon-head">
        <div className="patreon-crumbs">
          <button
            type="button"
            className="linklike"
            disabled={!campaign || loading}
            onClick={onBackToCampaigns}
          >
            Creators
          </button>
          {campaign && (
            <>
              <span className="patreon-crumb-sep">›</span>
              <span className="patreon-crumb-current">{campaign.name}</span>
            </>
          )}
        </div>
        <button type="button" className="small" disabled={loading} onClick={onReload}>
          Refresh
        </button>
      </div>

      {/* Ahead of the first drag, not after it: this decides whether a
          stranger's code runs here. Dismissed once, for this surface AND the
          in-TD palette page (`patreon_trust_ack`). */}
      {!trustAck && <PatreonTrustNotice variant="app" onDismiss={onDismissTrust} />}

      {error && <div className="patreon-error">{error}</div>}

      {loading ? (
        <div className="patreon-loading">Loading…</div>
      ) : !campaign ? (
        <>
          {campaigns.length > 0 && (
            <div className="patreon-sort">
              <label>Sort</label>
              <select
                value={campaignSort}
                onChange={(e) => onCampaignSortChange(e.target.value as PatreonCampaignSort)}
              >
                <option value="name">Name</option>
                <option value="latest">{campaignFilesOnly ? "Latest upload" : "Latest post"}</option>
              </select>
              <div className="view-toggle" role="group" aria-label="View">
                <button
                  type="button"
                  className={campaignView === "grid" ? "active" : ""}
                  onClick={() => onCampaignViewChange("grid")}
                >
                  Grid
                </button>
                <button
                  type="button"
                  className={campaignView === "list" ? "active" : ""}
                  onClick={() => onCampaignViewChange("list")}
                >
                  List
                </button>
              </div>
              <label
                className="check"
                title="Only show creators with a known .tox/.toe/.zip post (slower — scans post history)"
              >
                <input
                  type="checkbox"
                  checked={campaignFilesOnly}
                  onChange={(e) => onCampaignFilesOnlyChange(e.target.checked)}
                />
                TD files only
              </label>
              {(search.trim() || campaignFilesOnly) && (
                <span className="patreon-sort-count">
                  {sortedCampaigns.length} / {campaigns.length}
                </span>
              )}
            </div>
          )}
          {/* Patreon exposes no reliable list of free follows, so any creator
              can be pinned here by URL — paid, free, or merely followed. */}
          <div className="patreon-add-creator">
            <input
              type="text"
              value={creatorUrl}
              // The panel is narrow — keep the placeholder short and put the
              // example in the tooltip rather than letting it clip.
              placeholder="Add creator by URL"
              title="Paste a creator page URL (patreon.com/c/name), a creator name, or a campaign id"
              disabled={addingCreator}
              onChange={(e) => setCreatorUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCreator();
              }}
            />
            <button
              type="button"
              className="small"
              disabled={!creatorUrl.trim() || addingCreator}
              onClick={() => void submitCreator()}
            >
              {addingCreator ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && <div className="patreon-error">{addError}</div>}
          {/* Searching from the creator list searches the whole cache, not
              just the creator names on screen — so a filename you half
              remember finds its component without guessing whose it was. */}
          {search.trim() && (
            <>
              <div className="patreon-section-head">
                <span>Components</span>
                {cacheSearching ? (
                  <span className="patreon-section-count">searching…</span>
                ) : (
                  <span className="patreon-section-count">{cacheHits.length}</span>
                )}
              </div>
              {cacheHits.length > 0 ? (
                <CacheHitList
                  hits={cacheHits}
                  onOpen={onOpenHit}
                  onDragTox={onDragTox}
                  onPrimeDragTox={onPrimeDragTox}
                />
              ) : (
                !cacheSearching && (
                  <div className="patreon-loading">
                    {/* Downloads are always searched, so never claim nothing
                        was looked at — say what would widen the net instead. */}
                    {cachedCreators === 0
                      ? `No downloaded component matches "${search.trim()}". Open a creator once and everything they post becomes searchable from here too.`
                      : `No cached component matches "${search.trim()}". Creators opened so far: ${cachedCreators}.`}
                  </div>
                )
              )}
              <div className="patreon-section-head">
                <span>Creators</span>
                <span className="patreon-section-count">{sortedCampaigns.length}</span>
              </div>
            </>
          )}
          {campaigns.length === 0 ? (
            <div className="patreon-loading">
              No creators found for this account. Free follows don't show up here — paste a
              creator's URL above to add one.
            </div>
          ) : sortedCampaigns.length === 0 ? (
            <div className="patreon-loading">
              {search.trim()
                ? `No creator name matches "${search.trim()}".`
                : "No creators have a known .tox/.toe/.zip post yet."}
            </div>
          ) : (
            <CampaignList
              campaigns={sortedCampaigns}
              view={campaignView}
              dateByCampaign={campaignDateByCampaign}
              onSelect={onSelectCampaign}
              onRemove={onRemoveCreator}
            />
          )}
        </>
      ) : posts.length === 0 ? (
        <div className="patreon-loading">No posts found for this creator.</div>
      ) : (
        <>
          <div className="patreon-sort">
            <label>Sort</label>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="name">Name</option>
              <option value="type">Type</option>
            </select>
            <label className="check" title="Hide posts with no .tox/.toe/.zip attached">
              <input
                type="checkbox"
                checked={postsFilesOnly}
                onChange={(e) => onPostsFilesOnlyChange(e.target.checked)}
              />
              TD files only
            </label>
            <label className="check" title="Hide posts your tier can't view">
              <input
                type="checkbox"
                checked={postsHideLocked}
                onChange={(e) => onPostsHideLockedChange(e.target.checked)}
              />
              Hide locked
            </label>
            {(search.trim() || postsFilesOnly || postsHideLocked) && (
              <span className="patreon-sort-count">
                {sortedPosts.length} / {posts.length}
              </span>
            )}
          </div>
          {sortedPosts.length === 0 ? (
            <div className="patreon-loading">
              {emptyPostsMessage(search, postsFilesOnly, postsHideLocked)}
            </div>
          ) : (
          <div className="patreon-list">
            {sortedPosts.map((p) => {
            // The card stands in for the post's own files, so neither
            // gesture needs a detour through the detail pane: dragging it
            // drops the first .tox, double-clicking opens the first .toe
            // (the same pairing the file rows offer).
            const dragFile = firstToxFile(p);
            const open = postOpenAction(p);
            return (
            <button
              key={p.id}
              data-post-id={p.id}
              type="button"
              draggable={!!dragFile}
              className={[
                "patreon-post-row",
                p.id === selectedPostId ? "selected" : "",
                p.canView ? "" : "locked",
                dragFile ? "draggable-tox" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={
                [
                  !p.canView ? "Locked for your tier — click to open it on Patreon" : "",
                  dragFile ? `Drag ${dragFile.name} into a TouchDesigner network` : "",
                  open
                    ? open.kind === "toe"
                      ? `Double-click to open ${open.file.name}`
                      : `Double-click to unzip ${open.file.name}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              onClick={() => {
                onSelectPost(p.id);
                // Nothing here is fetchable for a locked post, so the click
                // takes you where it can be unlocked: the post on Patreon, in
                // the default browser. Selecting it still shows the teaser.
                if (!p.canView && p.url) onOpenUrl(p.url);
              }}
              onDoubleClick={
                open
                  ? () => {
                      const file = { name: open.file.name, url: open.file.url };
                      if (open.kind === "toe") onOpenToe(file);
                      // Selecting the post (the click that came with this
                      // double-click) opens the detail pane, so the extracted
                      // rows land where the user is already looking.
                      else onUnzip(file);
                    }
                  : undefined
              }
              onMouseDown={
                dragFile
                  ? () => onPrimeDragTox({ name: dragFile.name, url: dragFile.url })
                  : undefined
              }
              onDragStart={
                dragFile
                  ? (e) => onDragTox({ name: dragFile.name, url: dragFile.url }, e)
                  : undefined
              }
            >
              <DragGrip active={!!dragFile} />
              <span className="patreon-post-title">{p.title}</span>
              <span className="patreon-post-badges">
                {kinds(p.toxFiles).map((k) => (
                  <span key={k} className={`patreon-kind patreon-kind-${k}`}>
                    {k}
                  </span>
                ))}
                {!p.canView && <span className="patreon-lock">🔒</span>}
              </span>
            </button>
            );
            })}
          </div>
          )}
        </>
      )}
    </div>
  );
}

/** Right-stack post detail: text, embedded video, and file actions. */
export function PatreonDetail({
  post,
  loading,
  debug,
  sessions,
  target,
  busyFileUrl,
  zipExtractByUrl,
  onSelectTarget,
  onLoad,
  onOpenToe,
  onUnzip,
  onOpenExtractedFolder,
  onLoadLocal,
  onOpenLocalToe,
  onFileMenu,
  onDragTox,
  onPrimeDragTox,
  localToxByUrl,
  onOpenUrl,
}: {
  post: PatreonToxPost | null;
  loading: boolean;
  debug: string | null;
  sessions: ListItem[];
  target: ListItem | null;
  busyFileUrl: string | null;
  /** Extraction result per zip file URL, once unzipped — from App.tsx's on-demand cache. */
  zipExtractByUrl: Record<string, PatreonZipExtract | undefined>;
  onSelectTarget: (item: ListItem) => void;
  onLoad: (file: { name: string; url: string }, target: ListItem) => void;
  onOpenToe: (file: { name: string; url: string }) => void;
  onUnzip: (file: { name: string; url: string }) => void;
  onOpenExtractedFolder: (dir: string) => void;
  onLoadLocal: (file: { name: string; path: string }, target: ListItem) => void;
  onOpenLocalToe: (file: { name: string; path: string }) => void;
  /** "Add to Toolbox…" / "Add to Palette…" — .tox rows only (native, via url; extracted, via path). */
  onFileMenu: (file: { name: string; url?: string; path?: string }, e: MouseEvent) => void;
  /** Start an OS drag of a `.tox` row, downloading it first if needed. */
  onDragTox: (file: PatreonDragFile, e: DragEvent<HTMLElement>) => void;
  /** Mousedown warm-up: resolve the local path before the drag actually starts. */
  onPrimeDragTox: (file: PatreonDragFile) => void;
  /** Local paths for already-downloaded `.tox` files, keyed by URL — a row with one drags instantly. */
  localToxByUrl: Record<string, string | undefined>;
  onOpenUrl: (url: string) => void;
}) {
  // Route link clicks inside rendered post content to the OS browser.
  const onContentClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href");
    if (href && /^https?:/i.test(href)) {
      e.preventDefault();
      onOpenUrl(href);
    }
  };
  if (!post) {
    return (
      <div className="right-col patreon-detail-col">
        <div className="patreon-detail-empty">Select a post to preview it</div>
      </div>
    );
  }

  // Files found inside any zip attachments already unzipped for this post,
  // tagged with the zip they came from so the row can note its origin.
  const extractedFiles = post.toxFiles
    .filter((f) => f.kind === "zip")
    .flatMap((f) => (zipExtractByUrl[f.url]?.files ?? []).map((ef) => ({ ...ef, zipName: f.name })));
  const hasTox =
    post.toxFiles.some((f) => f.kind === "tox") || extractedFiles.some((f) => f.kind === "tox");

  return (
    <div className="right-col patreon-detail-col">
      <div className="patreon-detail-scroll">
        <h3 className="patreon-detail-title">{post.title}</h3>
        {post.publishedAt && (
          <div className="patreon-detail-date">{post.publishedAt.slice(0, 10)}</div>
        )}

        {/* Embedded video (YouTube/Vimeo/etc.) — provider iframe, sandboxed. */}
        {post.embedHtml ? (
          <div className="patreon-embed-frame">
            <iframe
              title="Embedded media"
              className="patreon-embed-iframe"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              srcDoc={embedDoc(post.embedHtml)}
            />
          </div>
        ) : post.isVideo || post.embedUrl ? (
          // Patreon-native video: HLS isn't playable inline, so link out with
          // the poster. External URL uses its own link.
          <a
            className="patreon-video-poster"
            href={post.embedUrl || post.url}
            target="_blank"
            rel="noreferrer"
            title="Open on Patreon to watch"
          >
            {post.imageUrl ? (
              <img src={post.imageUrl} alt="" className="patreon-detail-image" />
            ) : (
              <div className="patreon-video-noposter" />
            )}
            <span className="patreon-play-badge">▶ Watch on Patreon</span>
          </a>
        ) : post.imageUrl ? (
          <img src={post.imageUrl} alt="" className="patreon-detail-image" />
        ) : null}

        {/* Post body. Rich = we built the HTML from JSON (safe to render
            in-DOM, so links can route to the OS browser). Raw creator HTML
            stays sandboxed. */}
        {post.contentHtml && post.contentIsRich ? (
          <div
            className="patreon-content-rich"
            onClick={onContentClick}
            dangerouslySetInnerHTML={{ __html: post.contentHtml }}
          />
        ) : post.contentHtml ? (
          <iframe
            title="Post content"
            className="patreon-content-iframe"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={contentDoc(post.contentHtml)}
          />
        ) : loading ? (
          <div className="patreon-detail-content patreon-teaser">Loading post…</div>
        ) : post.teaser ? (
          <div className="patreon-detail-content patreon-teaser">
            {post.teaser}
            {!post.canView && (
              <div className="patreon-detail-locked">
                🔒 Your tier can't view the full post.{" "}
                {post.url && (
                  <button type="button" className="linkish" onClick={() => onOpenUrl(post.url)}>
                    Open on Patreon →
                  </button>
                )}
              </div>
            )}
          </div>
        ) : !post.canView ? (
          <div className="patreon-detail-locked">
            🔒 Your tier can't view this post.{" "}
            {post.url && (
              <button type="button" className="linkish" onClick={() => onOpenUrl(post.url)}>
                Open on Patreon →
              </button>
            )}
          </div>
        ) : null}

        {/* Temporary: surface the API shape when no body rendered. */}
        {!post.contentHtml && !loading && debug && (
          <div className="patreon-debug">{debug}</div>
        )}
      </div>

      {post.toxFiles.length > 0 && (
      <div className="patreon-detail-actions">
        {hasTox && (
          <div className="patreon-target">
            <label>Load .tox into</label>
            {sessions.length === 0 ? (
              <span className="patreon-target-none">No session running</span>
            ) : sessions.length === 1 ? (
              <span className="patreon-target-single">{sessions[0].displayName}</span>
            ) : (
              <select
                value={target?.path ?? ""}
                onChange={(e) => {
                  const next = sessions.find((s) => s.path === e.target.value);
                  if (next) onSelectTarget(next);
                }}
              >
                {sessions.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="patreon-detail-files">
          {post.toxFiles.map((f) => {
            // Only .tox can be dropped into a TD network; a locked post's
            // file can't be fetched at all, so neither can be dragged.
            const canDrag = f.kind === "tox" && post.canView;
            const ready = !!localToxByUrl[f.url];
            // Double-click is the row-level shortcut for the .toe "Open"
            // button, matching double-click-to-launch in Recent Files.
            const canOpen = f.kind === "toe" && post.canView && busyFileUrl !== f.url;
            // A zip row's double-click is whatever its button offers: unzip
            // it, or — once that's done — reveal the extracted folder. No
            // confirmation prompt: the same action sits one click away on the
            // button, so a dialog here would be friction, not a safeguard.
            const extracted = f.kind === "zip" ? zipExtractByUrl[f.url] : undefined;
            const canUnzip =
              f.kind === "zip" && post.canView && busyFileUrl !== f.url && !extracted;
            return (
            <div
              key={f.url}
              draggable={canDrag}
              className={["patreon-file", canDrag ? "draggable-tox" : ""]
                .filter(Boolean)
                .join(" ")}
              title={
                canDrag
                  ? ready
                    ? `Drag ${f.name} into a TouchDesigner network`
                    : `Drag ${f.name} into a TouchDesigner network (downloads on first drag)`
                  : canOpen
                    ? `Double-click to open ${f.name}`
                    : extracted
                      ? "Double-click to open the extracted folder"
                      : canUnzip
                        ? `Double-click to download and unzip ${f.name}`
                        : undefined
              }
              onDoubleClick={
                canOpen
                  ? () => onOpenToe({ name: f.name, url: f.url })
                  : extracted
                    ? () => onOpenExtractedFolder(extracted.extractedDir)
                    : canUnzip
                      ? () => onUnzip({ name: f.name, url: f.url })
                      : undefined
              }
              onContextMenu={
                f.kind === "tox" ? (e) => onFileMenu({ name: f.name, url: f.url }, e) : undefined
              }
              onMouseDown={
                canDrag ? () => onPrimeDragTox({ name: f.name, url: f.url }) : undefined
              }
              onDragStart={
                canDrag ? (e) => onDragTox({ name: f.name, url: f.url }, e) : undefined
              }
            >
              <DragGrip active={canDrag} />
              <span className="patreon-file-name" title={f.name}>
                {f.name}
              </span>
              <span className={`patreon-kind patreon-kind-${f.kind}`}>{f.kind}</span>
              {f.kind === "toe" ? (
                <button
                  type="button"
                  className="small"
                  disabled={!post.canView || busyFileUrl === f.url}
                  title={
                    post.canView
                      ? "Download to Recent Files, then pick a TD version to launch"
                      : "Your tier can't view this"
                  }
                  onClick={() => onOpenToe({ name: f.name, url: f.url })}
                >
                  {busyFileUrl === f.url ? "Adding…" : "Open"}
                </button>
              ) : f.kind === "zip" ? (
                zipExtractByUrl[f.url] ? (
                  <button
                    type="button"
                    className="small"
                    onClick={() => onOpenExtractedFolder(zipExtractByUrl[f.url]!.extractedDir)}
                    title="Already unzipped — open the extracted folder"
                  >
                    Open Folder
                  </button>
                ) : (
                  <button
                    type="button"
                    className="small"
                    disabled={!post.canView || busyFileUrl === f.url}
                    title={
                      post.canView
                        ? "Download and unzip — any .tox/.toe inside will show up below, ready to load"
                        : "Your tier can't view this"
                    }
                    onClick={() => onUnzip({ name: f.name, url: f.url })}
                  >
                    {busyFileUrl === f.url ? "Unzipping…" : "Unzip"}
                  </button>
                )
              ) : (
                <>
                <button
                  type="button"
                  className="small"
                  disabled={!post.canView || !target || busyFileUrl === f.url}
                  title={
                    !target
                      ? "Open a project in TouchDesigner first"
                      : post.canView
                        ? `Load into ${target.displayName}`
                        : "Your tier can't view this"
                  }
                  onClick={() => target && onLoad({ name: f.name, url: f.url }, target)}
                >
                  {busyFileUrl === f.url ? "Loading…" : "Load"}
                </button>
                <button
                  type="button"
                  className="small patreon-file-menu-btn"
                  title="Add to Toolbox or Palette…"
                  onClick={(e) => onFileMenu({ name: f.name, url: f.url }, e)}
                >
                  ⋮
                </button>
                </>
              )}
            </div>
            );
          })}
          {extractedFiles.map((ef) => (
            <div
              key={ef.path}
              draggable={ef.kind === "tox"}
              className={[
                "patreon-file",
                "patreon-file-extracted",
                ef.kind === "tox" ? "draggable-tox" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              // Already on disk from the unzip — this one drags with no wait.
              title={
                ef.kind === "tox"
                  ? `Drag ${ef.name} into a TouchDesigner network`
                  : ef.kind === "toe" && busyFileUrl !== ef.path
                    ? `Double-click to open ${ef.name}`
                    : undefined
              }
              onDoubleClick={
                ef.kind === "toe" && busyFileUrl !== ef.path
                  ? () => onOpenLocalToe({ name: ef.name, path: ef.path })
                  : undefined
              }
              onContextMenu={
                ef.kind === "tox" ? (e) => onFileMenu({ name: ef.name, path: ef.path }, e) : undefined
              }
              onDragStart={
                ef.kind === "tox"
                  ? (e) => onDragTox({ name: ef.name, path: ef.path }, e)
                  : undefined
              }
            >
              <DragGrip active={ef.kind === "tox"} />
              <span className="patreon-file-name" title={`${ef.name} — from ${ef.zipName}`}>
                ↳ {ef.name}
              </span>
              <span className={`patreon-kind patreon-kind-${ef.kind}`}>{ef.kind}</span>
              {ef.kind === "toe" ? (
                <button
                  type="button"
                  className="small"
                  disabled={busyFileUrl === ef.path}
                  title="Add to Recent Files, then pick a TD version to launch"
                  onClick={() => onOpenLocalToe({ name: ef.name, path: ef.path })}
                >
                  {busyFileUrl === ef.path ? "Adding…" : "Open"}
                </button>
              ) : (
                <>
                <button
                  type="button"
                  className="small"
                  disabled={!target || busyFileUrl === ef.path}
                  title={
                    target ? `Load into ${target.displayName}` : "Open a project in TouchDesigner first"
                  }
                  onClick={() => target && onLoadLocal({ name: ef.name, path: ef.path }, target)}
                >
                  {busyFileUrl === ef.path ? "Loading…" : "Load"}
                </button>
                <button
                  type="button"
                  className="small patreon-file-menu-btn"
                  title="Add to Toolbox or Palette…"
                  onClick={(e) => onFileMenu({ name: ef.name, path: ef.path }, e)}
                >
                  ⋮
                </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}

/** Distinct file kinds present on a post, tox before toe. */
function kinds(files: PatreonToxFile[]): string[] {
  const set = new Set(files.map((f) => f.kind));
  return ["tox", "toe", "zip"].filter((k) => set.has(k));
}

/** Wrap a provider embed snippet so it fills the frame. */
function embedDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
iframe,video{width:100%;height:100%;border:0}</style></head>
<body>${html}</body></html>`;
}

/** Wrap post HTML in a themed, scriptless document for the content iframe. */
function contentDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:transparent;color:#d8d8dc;
font:13px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;word-wrap:break-word}
a{color:#8ab4ff}img{max-width:100%;height:auto;border-radius:4px}
p{margin:0 0 .7em}pre,code{white-space:pre-wrap}
</style></head><body>${html}</body></html>`;
}

/**
 * Cross-creator results for the toolbar Search box: every `.tox` the launcher
 * has ever seen a listing for, plus every one already on disk — the answer to
 * "I know the filename, not the creator", which the creator-at-a-time browse
 * cannot give. Rows drag into TouchDesigner like any other; clicking one that
 * came from a known post opens that post.
 */
function CacheHitList({
  hits,
  onOpen,
  onDragTox,
  onPrimeDragTox,
}: {
  hits: PatreonSearchHit[];
  onOpen: (hit: PatreonSearchHit) => void;
  onDragTox: (file: PatreonDragFile, e: DragEvent<HTMLElement>) => void;
  onPrimeDragTox: (file: PatreonDragFile) => void;
}) {
  return (
    <div className="patreon-list patreon-hits">
      {hits.map((h) => {
        // A zip is not loadable into a network; its extracted members are
        // listed separately, so leave the archive itself undraggable.
        const dragFile: PatreonDragFile | null =
          h.kind === "zip"
            ? null
            : {
                name: h.name,
                url: h.url ?? undefined,
                path: h.localPath ?? undefined,
                campaign: h.campaignName,
              };
        const canOpen = !!(h.campaignId && h.postId);
        return (
          <button
            key={`${h.campaignName}/${h.localPath ?? h.url ?? h.name}`}
            type="button"
            draggable={!!dragFile}
            className={[
              "patreon-post-row",
              "patreon-hit-row",
              h.canView ? "" : "locked",
              dragFile ? "draggable-tox" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={
              [
                dragFile ? `Drag ${h.name} into a TouchDesigner network` : "",
                canOpen ? "Click to open the post it came from" : "",
                h.fromZip ? `Unpacked from ${h.fromZip}` : "",
                h.localPath ?? "",
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
            onClick={canOpen ? () => onOpen(h) : undefined}
            onMouseDown={dragFile ? () => onPrimeDragTox(dragFile) : undefined}
            onDragStart={dragFile ? (e) => onDragTox(dragFile, e) : undefined}
          >
            <DragGrip active={!!dragFile} />
            <span className="patreon-hit-text">
              <span className="patreon-hit-name">{h.name}</span>
              <span className="patreon-hit-where">
                {h.campaignName}
                {h.postTitle ? ` · ${h.postTitle}` : ""}
              </span>
            </span>
            <span className="patreon-post-badges">
              <span className={`patreon-kind patreon-kind-${h.kind}`}>{h.kind}</span>
              {h.localPath && (
                <span className="patreon-kind patreon-kind-local" title={h.localPath}>
                  on disk
                </span>
              )}
              {!h.canView && <span className="patreon-lock">🔒</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CampaignList({
  campaigns,
  view,
  dateByCampaign,
  onSelect,
  onRemove,
}: {
  campaigns: PatreonCampaign[];
  view: PatreonCampaignView;
  dateByCampaign: Record<string, string | null | undefined>;
  onSelect: (c: PatreonCampaign) => void;
  onRemove: (c: PatreonCampaign) => void;
}) {
  // Hand-added creators and the featured one are the only removable ones —
  // the rest come from the account itself and would just reappear. The × is a
  // sibling of the row button, never a child: a button inside a button is
  // invalid markup.
  const removeButton = (c: PatreonCampaign) =>
    c.manual || c.featured ? (
      <button
        type="button"
        className="patreon-campaign-remove"
        title={c.featured ? `Hide ${c.name} from this list` : `Remove ${c.name} from the list`}
        aria-label={c.featured ? `Hide ${c.name} from this list` : `Remove ${c.name} from the list`}
        onClick={() => onRemove(c)}
      >
        ×
      </button>
    ) : null;

  if (view === "list") {
    return (
      <div className="patreon-campaign-rows">
        {campaigns.map((c) => {
          const last = dateByCampaign[c.id];
          return (
            <div key={c.id} className="patreon-campaign-slot">
              <button
                type="button"
                className="patreon-campaign-row"
                onClick={() => onSelect(c)}
              >
                {c.avatarUrl ? (
                  <img src={c.avatarUrl} alt="" className="patreon-avatar patreon-avatar-sm" />
                ) : (
                  <span
                    className="patreon-avatar patreon-avatar-sm patreon-avatar-blank"
                    aria-hidden="true"
                  >
                    {c.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="patreon-campaign-row-name">{c.name}</span>
                {c.isOwn && <span className="patreon-own-badge">You</span>}
                <span className="patreon-campaign-row-date">
                  {last === undefined ? "" : last ? last.slice(0, 10) : "—"}
                </span>
              </button>
              {removeButton(c)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="patreon-campaigns">
      {campaigns.map((c) => (
        <div key={c.id} className="patreon-campaign-slot">
          <button type="button" className="patreon-campaign" onClick={() => onSelect(c)}>
            {c.avatarUrl ? (
              <img src={c.avatarUrl} alt="" className="patreon-avatar" />
            ) : (
              <span className="patreon-avatar patreon-avatar-blank" aria-hidden="true">
                {c.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="patreon-campaign-name">{c.name}</span>
            {c.isOwn && <span className="patreon-own-badge">You</span>}
          </button>
          {removeButton(c)}
        </div>
      ))}
    </div>
  );
}

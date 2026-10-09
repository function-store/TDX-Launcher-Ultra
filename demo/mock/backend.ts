// -- Browser-demo mock backend -------------------------------------------------
// Every Tauri `invoke` lands here. State is in-memory (plus a little
// localStorage via the real uiPersist), so the demo feels alive — launching
// adds a session, killing removes it, commits move the git log — but nothing
// ever touches a real machine.

import { emitMock } from "../shims/tauri-event";
import { avatarArt, heroArt, projectIcon } from "./art";
import {
  fnsDemoConfig,
  fnsDemoManifest,
  fnsDemoSessionStatus,
  fnsDemoStoreStatus,
  fnsDemoUiState, fnsDemoSetScope,
  fnsState,
} from "./fns";
import { DEMO_PREVIEWS } from "./previews";

/* ────────────────────────── demo universe ────────────────────────── */

const now = () => Math.floor(Date.now() / 1000);
const minsAgo = (m: number) => now() - m * 60;
const daysAgo = (d: number) => now() - d * 86400;

const HOME = "C:\\Users\\dan";
const PROJ = "C:\\Demo\\Projects";
const TPL = "C:\\Demo\\Templates";
const PALETTE_USER = `${HOME}\\Documents\\Derivative\\Palette`;
const PALETTE_TD = "C:\\Program Files\\Derivative\\TouchDesigner\\Samples\\Palette";

type Proj = {
  name: string;
  path: string;
  dir: string;
  build: string; // build string as inspect_toe reports it
  tags: string[];
  description: string;
  mtimeSecs: number;
  bytes: number;
  missing?: boolean;
  source: "td" | "launcher";
  lastOpened: number;
};

const projects: Proj[] = [
  {
    name: "AuroraSet",
    path: `${PROJ}\\AuroraSet\\AuroraSet.toe`,
    dir: `${PROJ}\\AuroraSet`,
    build: "TouchDesigner.2025.30060",
    tags: ["show/live", "client/nordlys"],
    description: "Live AV set — aurora ribbons over the particle floor.",
    mtimeSecs: minsAgo(52),
    bytes: 48_400_000,
    source: "launcher",
    lastOpened: minsAgo(47),
  },
  {
    name: "ParticleWall",
    path: `${PROJ}\\ParticleWall\\ParticleWall.toe`,
    dir: `${PROJ}\\ParticleWall`,
    build: "TouchDesigner.2025.32050",
    tags: ["installation"],
    description: "Lobby installation — POPs wall reacting to foot traffic.",
    mtimeSecs: daysAgo(2),
    bytes: 112_000_000,
    source: "launcher",
    lastOpened: daysAgo(2),
  },
  {
    name: "StageMapping",
    path: `${PROJ}\\StageMapping\\StageMapping.toe`,
    dir: `${PROJ}\\StageMapping`,
    build: "TouchDesigner.2025.30060",
    tags: ["show/live", "mapping"],
    description: "Projection mapping rig for the spring tour stage.",
    mtimeSecs: daysAgo(1),
    bytes: 66_500_000,
    source: "td",
    lastOpened: minsAgo(6),
  },
  {
    name: "KinectRig",
    path: `${PROJ}\\KinectRig\\KinectRig.toe`,
    dir: `${PROJ}\\KinectRig`,
    build: "TouchDesigner.2023.12370",
    tags: ["rnd"],
    description: "Depth-camera experiments; skeleton → instancing tests.",
    mtimeSecs: daysAgo(9),
    bytes: 21_300_000,
    source: "td",
    lastOpened: daysAgo(9),
  },
  {
    name: "AudioReactive",
    path: `${PROJ}\\AudioReactive\\AudioReactive.toe`,
    dir: `${PROJ}\\AudioReactive`,
    build: "TouchDesigner.2024.28110", // deliberately NOT installed → download flow
    tags: ["rnd", "audio"],
    description: "Audio-analysis sketchbook — needs a build that isn't installed.",
    mtimeSecs: daysAgo(30),
    bytes: 9_800_000,
    source: "launcher",
    lastOpened: daysAgo(30),
  },
  {
    name: "OldTitleSeq",
    path: `C:\\Demo\\Archive\\OldTitleSeq\\OldTitleSeq.toe`,
    dir: `C:\\Demo\\Archive\\OldTitleSeq`,
    build: "TouchDesigner.2022.33910",
    tags: [],
    description: "",
    mtimeSecs: daysAgo(400),
    bytes: 0,
    missing: true,
    source: "launcher",
    lastOpened: daysAgo(200),
  },
];

const byPath = (p: string) => projects.find((x) => x.path === p);

let templates: string[] = [
  `${TPL}\\Blank_1080p.toe`,
  `${TPL}\\LiveVisuals_Base.toe`,
  `${TPL}\\Projection_4K.toe`,
  `${TPL}\\AudioReactive_Starter.toe`,
];

const INSTALLED = [
  { key: "TouchDesigner.2023.12370", executable: "C:\\Program Files\\Derivative\\TouchDesigner.2023.12370\\bin\\TouchDesigner.exe" },
  { key: "TouchDesigner.2025.30060", executable: "C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchDesigner.exe" },
  { key: "TouchDesigner.2025.32050", executable: "C:\\Program Files\\Derivative\\TouchDesigner.2025.32050\\bin\\TouchDesigner.exe" },
];
const PLAYERS = [
  { key: "TouchPlayer.2025.30060", executable: "C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchPlayer.exe" },
];
// Grows when the demo "installs" a missing build.
const installedKeys = new Set(INSTALLED.map((v) => v.key));

/* config */

const config: Record<string, unknown> = {
  version: 3,
  // Presets over the multi-instance Scope tool below (registry >= 1.11.0):
  // the unpinned one lists once per live copy, the pinned one only on "Main out".
  quick_command_presets: [
    { label: "Freeze all scopes", target: "Scope#freeze", kwargs: {} },
    { label: "Main out at 50%", target: "Scope#set_gain@Main out", kwargs: { gain: "0.5" } },
  ],
  launcher_recents: [],
  td_recents: [],
  td_recents_timestamp: now(),
  templates: [],
  max_recent_files: 20,
  confirm_remove_from_list: true,
  show_icons: true,
  show_readme: false,
  collapse_versions: true,
  show_full_history: false,
  has_prompted_file_assoc: true,
  theme: "classic",
  view_mode: "gallery",
  show_tray: true,
  close_to_tray: true,
  global_hotkey_enabled: false,
  global_hotkey: "CommandOrControl+Shift+L",
  global_hotkey_main_enabled: false,
  global_hotkey_main: "",
  global_hotkey_palette_enabled: false,
  global_hotkey_palette: "",
  quit_after_launch: false,
  hide_after_launch: false,
  switch_to_current_after_launch: true,
  cli_fallback_version: "",
  keybindings: {},
  github_username: "nordlys-demo",
  github_token: "",
  patreon_session_cookie: "demo-session-cookie",
  patreon_download_root: "",
  backup_root: "E:\\TD_Backups",
  cloud_backup_root: "",
  backup_exclude: "CrashAutoSave*;*.dmp;Backup/*",
  backup_include: "",
  backup_max_file_mb: 512,
  backup_respect_gitignore: true,
  palette_extra_folders: "",
  package_index_url: "https://pypi.org",
  package_index_prefix: "tdp-",
  fns_base_url: "https://storage.functionstore.tools/fnstools",
  control_server_port: 9801,
  control_server_lan: false,
  control_touch_client: false,
  auto_update_check: true,
  skipped_app_version: "",
  skipped_utility_version: "",
  watch_tcp_port: 7401,
  watch_timeout_secs: 15,
  watch_launch_grace_secs: 90,
  watch_max_restarts: 3,
  watch_screenshot_on_crash: true,
  watch_reboot_after_crashes: 0,
  alert_email_enabled: false,
  alert_email_to: "",
  alert_email_from: "",
  alert_smtp_host: "",
  alert_smtp_port: 587,
  alert_smtp_security: "starttls",
  alert_smtp_username: "",
  alert_smtp_password: "",
  alert_on_stall: true,
  alert_on_relaunch: true,
  alert_on_gave_up: true,
  alert_on_reboot: true,
  alert_attach_screenshot: true,
  alert_cooldown_secs: 600,
  perf_monitor_enabled: true,
  perf_poll_secs: 5,
};

/* recents */

type Recent = { path: string; source: string; last_opened: number };
let recents: Recent[] = projects.map((p) => ({
  path: p.path,
  source: p.source,
  last_opened: p.lastOpened,
}));

/* variant families (Name.N.toe increments, Backup copies, crash autosaves) */

type MockVariant = {
  path: string;
  kind: "head" | "increment" | "backup" | "crash";
  ordinal: number | null;
  modified: number;
  size: number;
  last_opened?: number | null;
};

const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

// AuroraSet: the full story — increments, backups, a crash newer than the head.
// StageMapping: a modest two-increment family. Everyone else is a singleton.
const variantFamilies: Record<string, MockVariant[]> = {
  [`${PROJ}\\AuroraSet`]: [
    { path: `${PROJ}\\AuroraSet\\AuroraSet.toe`, kind: "head", ordinal: null, modified: minsAgo(52), size: 48_400_000 },
    { path: `${PROJ}\\AuroraSet\\AuroraSet.7.toe`, kind: "increment", ordinal: 7, modified: minsAgo(47), size: 48_100_000, last_opened: minsAgo(21) },
    { path: `${PROJ}\\AuroraSet\\AuroraSet.6.toe`, kind: "increment", ordinal: 6, modified: minsAgo(140), size: 47_400_000 },
    { path: `${PROJ}\\AuroraSet\\AuroraSet.5.toe`, kind: "increment", ordinal: 5, modified: daysAgo(1), size: 46_900_000 },
    { path: `${PROJ}\\AuroraSet\\Backup\\AuroraSet.31.toe`, kind: "backup", ordinal: 31, modified: daysAgo(1), size: 46_800_000 },
    { path: `${PROJ}\\AuroraSet\\Backup\\AuroraSet.30.toe`, kind: "backup", ordinal: 30, modified: daysAgo(3), size: 44_100_000 },
    { path: `${PROJ}\\AuroraSet\\CrashAutoSave.AuroraSet.toe`, kind: "crash", ordinal: null, modified: minsAgo(9), size: 48_200_000 },
  ],
  [`${PROJ}\\StageMapping`]: [
    { path: `${PROJ}\\StageMapping\\StageMapping.toe`, kind: "head", ordinal: null, modified: daysAgo(1), size: 66_500_000 },
    { path: `${PROJ}\\StageMapping\\StageMapping.2.toe`, kind: "increment", ordinal: 2, modified: daysAgo(2), size: 65_000_000 },
  ],
};

function mockFamilies() {
  const fams: unknown[] = [];
  const claimed = new Set<string>();
  for (const p of projects) {
    if (p.missing) continue;
    const variants = variantFamilies[p.dir] ?? [
      { path: p.path, kind: "head", ordinal: null, modified: p.mtimeSecs, size: p.bytes } as MockVariant,
    ];
    if (claimed.has(p.dir)) continue;
    claimed.add(p.dir);
    const head = variants.find((v) => v.kind === "head") ?? null;
    const withOpened = variants.map((v) => ({
      ...v,
      last_opened:
        v.last_opened ?? recents.find((r) => normPath(r.path) === normPath(v.path))?.last_opened ?? null,
    }));
    const lastOpened = withOpened
      .filter((v) => v.last_opened != null)
      .sort((a, b) => (b.last_opened ?? 0) - (a.last_opened ?? 0))[0];
    const crash = withOpened.find((v) => v.kind === "crash");
    fams.push({
      key: `${normPath(p.dir)}|${p.name.toLowerCase()}`,
      display_name: p.name,
      dir: p.dir,
      head: head?.path ?? null,
      latest_activity: Math.max(...withOpened.flatMap((v) => [v.modified, v.last_opened ?? 0])),
      last_opened_variant: lastOpened?.path ?? null,
      crash_newer_than_head: !!crash && (!head || crash.modified > head.modified),
      reclaimable_bytes: withOpened.filter((v) => v.kind !== "head").reduce((s, v) => s + v.size, 0),
      variants: withOpened,
      member_paths: withOpened.map((v) => normPath(v.path)),
    });
  }
  return fams;
}

/* running sessions */

type Session = {
  id: string;
  path: string;
  display_name: string;
  pid: number | null;
  alive: boolean;
  version_key: string | null;
  use_touchplayer: boolean;
  envoy_port: number | null;
  envoy_up: boolean | null;
  mcp_available: boolean;
  utility_available: boolean | null;
  utility_version: string | null;
  source: string;
  started_at: number | null;
  ended_at?: number | null;
  windows: unknown[];
  instances: SessionInstance[];
};

/** One process. Two on a row = the same .toe opened twice; see the real
 *  `SessionInstance` in src-tauri/src/open_projects.rs. */
type SessionInstance = {
  pid: number;
  source: string;
  started_at: number | null;
  windows: unknown[];
};

const win = (
  id: number,
  pid: number,
  title: string,
  extra?: Partial<Record<string, unknown>>,
) => ({
  id,
  pid,
  title,
  owned: false,
  minimized: false,
  foreground: false,
  monitor: 1,
  monitor_primary: true,
  x: 120,
  y: 80,
  width: 1920,
  height: 1080,
  pane_type: null,
  pane_owner: null,
  ...extra,
});

let sessions: Session[] = [
  {
    id: "sess-aurora",
    path: `${PROJ}\\AuroraSet\\AuroraSet.toe`,
    display_name: "AuroraSet",
    pid: 18244,
    alive: true,
    version_key: "TouchDesigner.2025.30060",
    use_touchplayer: false,
    envoy_port: 9870,
    envoy_up: true,
    mcp_available: true,
    utility_available: true,
    utility_version: "0.3.0",
    source: "launcher",
    started_at: minsAgo(47),
    windows: [
      win(70101, 18244, "AuroraSet - TouchDesigner 2025.30060"),
      win(70102, 18244, "Perform: /AuroraSet/out", {
        owned: true,
        pane_type: "PANEL",
        pane_owner: "/AuroraSet/ui",
        width: 1280,
        height: 720,
        x: 400,
        y: 220,
      }),
    ],
    instances: [
      {
        pid: 18244,
        source: "launcher",
        started_at: minsAgo(47),
        windows: [
          win(70101, 18244, "AuroraSet - TouchDesigner 2025.30060"),
          win(70102, 18244, "Perform: /AuroraSet/out", {
            owned: true,
            pane_type: "PANEL",
            pane_owner: "/AuroraSet/ui",
            width: 1280,
            height: 720,
            x: 400,
            y: 220,
          }),
        ],
      },
    ],
  },
  {
    id: "sess-stage",
    path: `${PROJ}\\StageMapping\\StageMapping.toe`,
    display_name: "StageMapping",
    pid: 20918,
    alive: true,
    // Opened outside the launcher — no recorded build (as the real process
    // scan reports it). Killing it must still leave a relaunchable tombstone,
    // its build resolved from the .toe.
    version_key: null,
    use_touchplayer: false,
    envoy_port: null,
    envoy_up: null,
    mcp_available: false,
    utility_available: false, // running, but no companion loaded
    utility_version: null,
    source: "process",
    started_at: null, // opened externally — uptime unknown
    windows: [win(70201, 20918, "StageMapping - TouchDesigner 2025.30060")],
    instances: [
      {
        pid: 20918,
        source: "process",
        started_at: null,
        windows: [win(70201, 20918, "StageMapping - TouchDesigner 2025.30060")],
      },
    ],
  },
];

let nextPid = 24000;
/** Phone Remote demo state: flips on once paired, lights the header button. */
let phoneServing = false;

/* palette + toolbox */

const paletteItems = [
  // User palette
  { name: "BloomStack.tox", folder: "" },
  { name: "CueList.tox", folder: "" },
  { name: "NDIRouter.tox", folder: "" },
  { name: "OSCBridge.tox", folder: "" },
  { name: "LookAheadCue.tox", folder: "Live" },
  { name: "MidiMatrix.tox", folder: "Live" },
  { name: "TDXLauncherUtility.tox", folder: "TDXLU" },
].map((t) => ({
  path: `${PALETTE_USER}\\${t.folder ? t.folder + "\\" : ""}${t.name}`,
  name: t.name,
  folder: t.folder,
  root: PALETTE_USER,
  root_label: "User Palette",
}));

const factoryPalette = [
  { name: "camSchnappr.tox", folder: "Mapping" },
  { name: "kantanMapper.tox", folder: "Mapping" },
  { name: "particlesGpu.tox", folder: "Tools" },
  { name: "moviePlayer.tox", folder: "Tools" },
  { name: "lightAlign.tox", folder: "Tools" },
  { name: "superRes.tox", folder: "Image" },
  { name: "pointillize.tox", folder: "Image" },
].map((t) => ({
  path: `${PALETTE_TD}\\${t.folder}\\${t.name}`,
  name: t.name,
  folder: t.folder,
  root: PALETTE_TD,
  root_label: "Derivative",
}));

type Tool = {
  id: string;
  label: string;
  kind: "local" | "url" | "package";
  source: string;
  category: string;
  notes: string;
  resolvedPath: string | null;
  missing: boolean;
};

let toolboxCategories: string[] = ["Generators", "Show Control", "Utils"];
let toolboxTools: Tool[] = [
  {
    id: "tool-utility",
    label: "Launcher Utility",
    kind: "local",
    source: `${PALETTE_USER}\\TDXLU\\TDXLauncherUtility.tox`,
    category: "",
    notes: "Companion TOX — drag into any project to unlock the Companion bar.",
    resolvedPath: `${PALETTE_USER}\\TDXLU\\TDXLauncherUtility.tox`,
    missing: false,
  },
  {
    id: "tool-bloom",
    label: "BloomStack",
    kind: "local",
    source: `${PALETTE_USER}\\BloomStack.tox`,
    category: "Generators",
    notes: "",
    resolvedPath: `${PALETTE_USER}\\BloomStack.tox`,
    missing: false,
  },
  {
    id: "tool-noise",
    label: "NoiseField",
    kind: "url",
    source: "function-store/NoiseField",
    category: "Generators",
    notes: "Latest GitHub release",
    resolvedPath: null, // ☁ not fetched yet
    missing: false,
  },
  {
    id: "tool-cue",
    label: "CueList",
    kind: "local",
    source: `${PALETTE_USER}\\CueList.tox`,
    category: "Show Control",
    notes: "",
    resolvedPath: `${PALETTE_USER}\\CueList.tox`,
    missing: false,
  },
  {
    id: "tool-osc",
    label: "OSCBridge",
    kind: "local",
    source: `${PALETTE_USER}\\OSCBridge.tox`,
    category: "Utils",
    notes: "",
    resolvedPath: `${PALETTE_USER}\\OSCBridge.tox`,
    missing: false,
  },
  {
    id: "tool-timecode",
    label: "tdp-timecode",
    kind: "package",
    source: "tdp-timecode",
    category: "Utils",
    notes: "Install via Sessions → Companion → From package",
    resolvedPath: null,
    missing: false,
  },
];
let nextToolId = 100;

const toolboxView = () => ({ categories: [...toolboxCategories], tools: toolboxTools.map((t) => ({ ...t })) });

/* git — only AuroraSet is a repo out of the box */

type GitState = {
  is_repo: boolean;
  branch: string;
  branches: string[];
  ahead: number;
  changes: { path: string; index_status: string; worktree_status: string; staged: boolean; unstaged: boolean; untracked: boolean; old_path: null; bytes: number | null }[];
  log: { hash: string; short_hash: string; author: string; email: string; timestamp: number; relative_time: string; subject: string }[];
};

const mkCommit = (n: number, tsDays: number, subject: string) => {
  const hash = (n * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(5).slice(0, 40);
  return {
    hash,
    short_hash: hash.slice(0, 7),
    author: "Dan Molnar",
    email: "dan@nordlys.demo",
    timestamp: daysAgo(tsDays),
    relative_time: tsDays === 0 ? "2 hours ago" : tsDays === 1 ? "yesterday" : `${tsDays} days ago`,
    subject,
  };
};

const gitStates = new Map<string, GitState>();
gitStates.set(`${PROJ}\\AuroraSet`, {
  is_repo: true,
  branch: "main",
  branches: ["main", "show-day"],
  ahead: 1,
  changes: [
    { path: "AuroraSet.toe", index_status: " ", worktree_status: "M", staged: false, unstaged: true, untracked: false, old_path: null, bytes: 48_400_000 },
    { path: "README.md", index_status: "M", worktree_status: " ", staged: true, unstaged: false, untracked: false, old_path: null, bytes: 2_100 },
    { path: "preview/preview.png", index_status: "?", worktree_status: "?", staged: false, unstaged: false, untracked: true, old_path: null, bytes: 412_000 },
  ],
  log: [
    mkCommit(6, 0, "Tighten bloom pass on the ribbon layer"),
    mkCommit(5, 1, "Collect media before the venue run"),
    mkCommit(4, 3, "Cue list: add blackout + strobe safety"),
    mkCommit(3, 7, "Externalize scene COMPs"),
    mkCommit(2, 12, "Aurora ribbons v2 — GPU instancing"),
    mkCommit(1, 19, "Initial commit"),
  ],
});

function gitStatusFor(projectDir: string) {
  const st = gitStates.get(projectDir);
  if (!st || !st.is_repo) {
    return {
      project_dir: projectDir,
      is_repo: false,
      root: null,
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      has_upstream: false,
      branches: [],
      remotes: [],
      remote_urls: [],
      staged: 0,
      unstaged: 0,
      untracked: 0,
      changes: [],
      summary: "Not a git repository",
    };
  }
  const staged = st.changes.filter((c) => c.staged).length;
  const unstaged = st.changes.filter((c) => c.unstaged).length;
  const untracked = st.changes.filter((c) => c.untracked).length;
  const bits = [
    staged && `${staged} staged`,
    unstaged && `${unstaged} modified`,
    untracked && `${untracked} untracked`,
  ].filter(Boolean);
  return {
    project_dir: projectDir,
    is_repo: true,
    root: projectDir,
    branch: st.branch,
    dirty: st.changes.length > 0,
    ahead: st.ahead,
    behind: 0,
    has_upstream: true,
    branches: st.branches,
    remotes: ["origin"],
    remote_urls: ["https://github.com/nordlys-demo/AuroraSet.git"],
    staged,
    unstaged,
    untracked,
    changes: st.changes.map((c) => ({ ...c })),
    summary: bits.length ? bits.join(" · ") : "Clean",
  };
}

const README_DIFF = `--- a/README.md
+++ b/README.md
@@ -1,6 +1,8 @@
 # AuroraSet

 Live AV set for the Nordlys tour.
+
+Cue 14 now holds on the ribbon freeze until the MIDI release.

 ## Rig
 - 2x 4K outputs, NDI monitor feed`;

/* watch */

type WatchSession = {
  id: string;
  active: boolean;
  phase: string;
  project_path: string;
  version_key: string;
  use_touchplayer: boolean;
  pid: number | null;
  last_heartbeat_secs_ago: number | null;
  fps: number | null;
  crash_count: number;
  message: string;
  log_lines: string[];
};

const watchId = (path: string) => {
  const base = path.replace(/\\/g, "/").split("/").pop() || path;
  return `toe-${base.replace(/\.toe$/i, "").toLowerCase()}`;
};

let watchSessions: WatchSession[] = [];

const watchOverview = () => ({
  listening: true,
  port: config.watch_tcp_port as number,
  sessions: watchSessions.map((s) => ({
    ...s,
    last_heartbeat_secs_ago: s.active ? 1 + Math.random() * 3 : null,
    fps: s.active ? 59 + Math.random() * 1.5 : null,
  })),
  message: watchSessions.length
    ? `Watching ${watchSessions.length} project${watchSessions.length > 1 ? "s" : ""}`
    : "Idle — no watches",
});

/* patreon */

// The creator shelf mirrors the real one (with permission-safe content: only
// Function Store — our own campaign — and Lake Heckaman get mock posts; every
// other creator is shelf-only and never opened in the demo or the hero video).
const mkCampaign = (id: string, name: string, isOwn = false) => ({
  id,
  name,
  url: "https://patreon.com/demo_" + id.slice(2),
  avatarUrl: avatarArt(name),
  isOwn,
  manual: false,
});
const campaigns = [
  mkCampaign("c-acrylicode", "Acrylicode Berlin"),
  mkCampaign("c-akenbak", "Akenbak"),
  mkCampaign("c-dzhezus", "Alexander Dzhezus"),
  mkCampaign("c-alltd", "alltd.org"),
  mkCampaign("c-alphamoonbase", "AlphaMoonbase.Berlin"),
  mkCampaign("c-b2bk", "b2bk"),
  mkCampaign("c-bennjordan", "Benn Jordan"),
  mkCampaign("c-elekktronaut", "bileam tschepe (elekktronaut)"),
  mkCampaign("c-darienbrito", "Darien Brito"),
  mkCampaign("c-decayingsun", "Decaying Sun"),
  mkCampaign("c-dotsimulate", "DotSimulate"),
  { id: "c-functionstore", name: "Function Store", url: "https://patreon.com/function_store", avatarUrl: avatarArt("Function Store"), isOwn: true, manual: false },
  mkCampaign("c-josefpelz", "Josef Pelz"),
  { id: "c-lakeheckaman", name: "Lake Heckaman", url: "https://patreon.com/demo_lakeheckaman", avatarUrl: avatarArt("Lake Heckaman"), isOwn: false, manual: false },
  mkCampaign("c-matterform", "Matterform, Inc."),
  mkCampaign("c-miniuv", "Mini UV"),
  mkCampaign("c-paketa12", "paketa12"),
  mkCampaign("c-paoolea", "Pao Olea"),
  mkCampaign("c-polyforms", "Polyforms"),
  mkCampaign("c-polyhop", "Polyhop"),
  mkCampaign("c-prismatic", "prismatic"),
  mkCampaign("c-sarv", "SARV"),
  mkCampaign("c-studioedul", "STUDIO EDUL"),
  mkCampaign("c-supermarketsallad", "supermarket sallad"),
  mkCampaign("c-tekt", "Tekt (Immerse Studio)"),
  mkCampaign("c-torinblankensmith", "Torin Blankensmith"),
  mkCampaign("c-unveil", "Unveil"),
];

const iso = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

/** Real post titles from Function Store's and Lake Heckaman's actual feeds
 *  (the creators' own tools; bodies, dates and files are stand-ins). */
const mkPatreonPost = (
  id: string,
  days: number,
  title: string,
  files: [string, string][],
  body: string,
) => ({
  id,
  title,
  url: `https://patreon.com/posts/demo-${id}`,
  publishedAt: iso(days),
  canView: true,
  toxFiles: files.map(([name, kind]) => ({ name, url: `demo://${kind}/${name}`, source: "attachment", kind })),
  contentHtml: `<p>${body}</p>`,
  teaser: null,
  embedHtml: null,
  embedUrl: null,
  embedProvider: null,
  imageUrl: heroArt(title.slice(0, 18), title.slice(0, 30)),
  contentIsRich: true,
});

const patreonPosts: Record<string, unknown[]> = {
  "c-functionstore": [
    mkPatreonPost("p-101", 2, "Realistic Rice in TouchDesigner - Project File and stream recording", [["RealisticRice.toe", "toe"]], "Project file plus the full stream recording."),
    mkPatreonPost("p-102", 4, "Mega Projectfile with many of my tools used together to create unique visuals!", [["MegaProject.toe", "toe"]], "One project, most of the tools, wired into a single output."),
    mkPatreonPost("p-103", 6, "CHOP Anatomy MEGAPACK [exclusive files]", [["CHOPAnatomy.tox", "tox"], ["CHOPAnatomy.toe", "toe"]], "Every example from the CHOP Anatomy series, packed."),
    mkPatreonPost("p-104", 9, "CircularDistortionTOP", [["CircularDistortionTOP.tox", "tox"]], "Polar-friendly distortion with edge behavior controls."),
    mkPatreonPost("p-105", 12, "SwitchTools Update --- Callbacks and POPs unloading", [["SwitchTools.tox", "tox"]], "Callbacks on switch, and clean unloading for POPs branches."),
    mkPatreonPost("p-106", 15, "CamSequencer/OpSequencer spline interpolation fix", [["CamSequencer.tox", "tox"]], "Spline interpolation across queued moves behaves again."),
    mkPatreonPost("p-107", 18, "POPs Circle Jam [Exclusive Project File & Breakdown]", [["POPsCircleJam.toe", "toe"]], "The circle jam patch with a full breakdown."),
    mkPatreonPost("p-108", 21, "ExpressionPOP - quick attribute math expressions", [["ExpressionPOP.tox", "tox"]], "Attribute math without the boilerplate."),
    mkPatreonPost("p-109", 24, "SwitchTools Enhanced [Patreon Exclusive Component]", [["SwitchToolsEnhanced.tox", "tox"]], "The enhanced build, exclusive to patrons."),
    mkPatreonPost("p-110", 28, "Updated Interactive POP particles (project file and component)", [["InteractivePOPParticles.tox", "tox"], ["InteractivePOPParticles.toe", "toe"]], "Interactive particles, now as component and project file."),
    mkPatreonPost("p-111", 31, "particlesGpuUltimate component (updated)", [["particlesGpuUltimate.tox", "tox"], ["particlesGpuUltimate.toe", "toe"]], "The ultimate build, refreshed."),
    mkPatreonPost("p-112", 35, "particlesGpu effectors project file --- without \"ultimate\"", [["particlesGpuEffectors.toe", "toe"]], "Effectors setup for the base particlesGpu."),
    mkPatreonPost("p-113", 39, "Interpolating between random presets with Op/CamSequencer", [["PresetInterp.tox", "tox"]], "Random preset walks, smoothly interpolated."),
    mkPatreonPost("p-114", 52, "TDMap - Seamless MIDI Mapping with any controller, and much more", [["TDMap.tox", "tox"]], "Seamless MIDI mapping with any controller — and much more."),
  ],
  "c-lakeheckaman": [
    mkPatreonPost("p-301", 3, "GSOPs v0.1.83: Ease-of-use Updates and Bug Fixes", [["GSOPs.tox", "tox"]], "Gaussian splatting operators — ease-of-use updates and fixes."),
    mkPatreonPost("p-302", 9, "bday gifts from me to you", [["bday_gifts.toe", "toe"]], "A little bundle of project files."),
    mkPatreonPost("p-303", 14, "ASCII \"Encryption\" with POPs in TouchDesigner", [["ASCIIEncryption.toe", "toe"]], "Character-field trickery with POPs."),
    mkPatreonPost("p-304", 20, "No-Code Caustics in TouchDesigner using the RayPOP", [["NoCodeCaustics.toe", "toe"]], "Caustics from the RayPOP, no GLSL required."),
    mkPatreonPost("p-305", 27, "Interactive Infected Network with POPs in TouchDesigner", [["InfectedNetwork.tox", "tox"], ["InfectedNetwork.toe", "toe"]], "Growth propagation over a network of points."),
    mkPatreonPost("p-306", 33, "TDGS: 1.3.2", [["TDGS.tox", "tox"], ["TDGS_1.3.2.zip", "zip"]], "Gaussian splat renderer, maintenance release."),
    mkPatreonPost("p-307", 41, "Realtime, Interactive Erosion Simulation In TouchDesigner", [["ErosionSim.tox", "tox"], ["ErosionSim.toe", "toe"]], "Hydraulic erosion, interactive and realtime."),
    mkPatreonPost("p-308", 49, "Color Grading Component: Exposure Curves, Color Wheels, RGBCMY band correction", [["ColorGrade.tox", "tox"], ["ColorGrade.toe", "toe"]], "A full grading chain in one component."),
  ],
  "c-polyforms": [
    {
      id: "p-201",
      title: "GeoScatter — instancing helper",
      url: "https://patreon.com/posts/demo-201",
      publishedAt: iso(6),
      canView: true,
      toxFiles: [
        { name: "GeoScatter.tox", url: "demo://tox/GeoScatter.tox", source: "attachment", kind: "tox" },
      ],
      contentHtml: "<p>Scatter instances over any SOP with weight maps.</p>",
      teaser: null,
      embedHtml: null,
      embedUrl: null,
      embedProvider: null,
      imageUrl: heroArt("GeoScatter", "GeoScatter"),
      contentIsRich: true,
    },
    {
      id: "p-202",
      title: "SDF toolkit (higher tier)",
      url: "https://patreon.com/posts/demo-202",
      publishedAt: iso(11),
      canView: false, // locked post — shows the can't-view state
      toxFiles: [{ name: "SDFKit.tox", url: "demo://tox/SDFKit.tox", source: "attachment", kind: "tox" }],
      contentHtml: null,
      teaser: "Raymarched SDF primitives with boolean ops — available on the Studio tier.",
      embedHtml: null,
      embedUrl: null,
      embedProvider: null,
      imageUrl: heroArt("SDF toolkit", "SDF toolkit"),
      contentIsRich: false,
    },
  ],
  "c-noisedept": [
    {
      id: "p-301",
      title: "GrainField audio-reactive base",
      url: "https://patreon.com/posts/demo-301",
      publishedAt: iso(2),
      canView: true,
      toxFiles: [
        { name: "GrainField.tox", url: "demo://tox/GrainField.tox", source: "attachment", kind: "tox" },
      ],
      contentHtml: "<p>The granular field patch from last week's stream, cleaned up with exposed pars.</p>",
      teaser: null,
      embedHtml: null,
      embedUrl: null,
      embedProvider: null,
      imageUrl: heroArt("GrainField", "GrainField"),
      contentIsRich: true,
    },
  ],
};

/* control panel schema (companion "exposed parameters") */

const controlValues: Record<string, Record<string, unknown>> = {
  perform: {
    Brightness: 0.82,
    Speed: 0.35,
    Scene: "aurora",
    Strobe: 0,
    Fogamount: 0.4,
    Beats: 4,
    Offsetx: 0.1,
    Offsety: -0.2,
  },
  mixer: { Crossfade: 0.5, Deckalevel: 1, Deckblevel: 0.72, Tintr: 0.9, Tintg: 0.55, Tintb: 0.3 },
  lasers: { Beamcount: 8, Spread: 0.6 },
};

const par = (name: string, label: string, style: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  name,
  label,
  style,
  page: "Control",
  mode: "CONSTANT",
  value,
  enabled: true,
  readonly: false,
  tuplet: name,
  vecindex: 0,
  tupletsize: 1,
  min: 0,
  max: 1,
  clampmin: true,
  clampmax: true,
  normmin: 0,
  normmax: 1,
  default: value,
  ...extra,
});

/* Remotely add-able COMPs (control_comps / control_add / control_remove).
   Adding "lasers" grows the schema with a small third target, like a real
   Control-sequence block would. */
let laserAdded = false;
// A little COMP network for the lazy tree. Root layer (parent "") maps to the
// AuroraSet children; each request returns one layer's immediate children.
const COMP_NODES: { path: string; pars: number }[] = [
  { path: "/AuroraSet/lasers", pars: 2 },
  { path: "/AuroraSet/mixer", pars: 6 },
  { path: "/AuroraSet/media", pars: 4 },
  { path: "/AuroraSet/stage", pars: 3 },
  { path: "/AuroraSet/stage/trusses", pars: 2 },
  { path: "/AuroraSet/scenes", pars: 0 }, // pure folder
  { path: "/AuroraSet/scenes/intro", pars: 5 },
  { path: "/AuroraSet/scenes/main", pars: 8 },
  { path: "/AuroraSet/scenes/main/fx", pars: 0 }, // pure folder
  { path: "/AuroraSet/scenes/main/fx/bloom", pars: 3 },
];
const controlComps = (parent?: string) => {
  const base = parent && parent.length ? parent : "/AuroraSet";
  const baseDepth = base.split("/").filter(Boolean).length;
  const hasKids = (p: string) => COMP_NODES.some((n) => n.path.startsWith(`${p}/`));
  const comps = COMP_NODES.filter((n) => {
    const segs = n.path.split("/").filter(Boolean);
    return n.path.startsWith(`${base}/`) && segs.length === baseDepth + 1;
  }).map((n) => ({
    path: n.path,
    name: n.path.split("/").pop(),
    pars: n.pars,
    added: n.path === "/AuroraSet/lasers" ? laserAdded : n.path === "/AuroraSet/mixer",
    has_children: hasKids(n.path),
  }));
  return { ok: true, parent: parent && parent.length ? base : "", comps };
};
const controlSchema = () => ({
  ok: true,
  hash: laserAdded ? "demo-schema-2" : "demo-schema-1",
  targets: [
    ...(laserAdded
      ? [
          {
            key: "block1",
            path: "/AuroraSet/lasers",
            name: "lasers",
            builtin: false,
            pars: [
              par("Beamcount", "Beam Count", "Int", controlValues.lasers.Beamcount, {
                min: 1, max: 32, normmin: 1, normmax: 32,
              }),
              par("Spread", "Spread", "Float", controlValues.lasers.Spread),
            ],
          },
        ]
      : []),
    {
      key: "perform",
      path: "/AuroraSet/perform",
      name: "Perform",
      builtin: true,
      // Spread across the COMP's Custom pages (Look / Timing / Position) so the
      // control panel groups them under page sub-headers instead of one dump.
      pars: [
        par("Brightness", "Brightness", "Float", controlValues.perform.Brightness, { page: "Look" }),
        par("Speed", "Speed", "Float", controlValues.perform.Speed, { page: "Look", max: 2, normmax: 2 }),
        par("Fogamount", "Fog Amount", "Float", controlValues.perform.Fogamount, { page: "Look" }),
        par("Scene", "Scene", "Menu", controlValues.perform.Scene, {
          page: "Look",
          menunames: ["aurora", "particles", "tunnel", "blackout"],
          menulabels: ["Aurora", "Particles", "Tunnel", "Blackout"],
        }),
        par("Strobe", "Strobe", "Toggle", controlValues.perform.Strobe, { page: "Look" }),
        par("Resetlook", "Reset Look", "Pulse", 0, { page: "Look" }),
        // Int — the one style that gets −/+ nudge steppers.
        par("Beats", "Beats / Bar", "Int", controlValues.perform.Beats, {
          page: "Timing", min: 1, max: 16, normmin: 1, normmax: 16,
        }),
        // XY tuplet — exercises the expandable ParGroup row.
        par("Offsetx", "Offset", "Float", controlValues.perform.Offsetx, {
          page: "Position", tuplet: "Offset", tupletsize: 2, vecindex: 0, min: -1, normmin: -1,
        }),
        par("Offsety", "Offset", "Float", controlValues.perform.Offsety, {
          page: "Position", tuplet: "Offset", tupletsize: 2, vecindex: 1, min: -1, normmin: -1,
        }),
      ],
    },
    {
      key: "mixer",
      path: "/AuroraSet/mixer",
      name: "SceneMixer",
      builtin: false,
      pars: [
        par("Crossfade", "Crossfade", "Float", controlValues.mixer.Crossfade),
        par("Deckalevel", "Deck A Level", "Float", controlValues.mixer.Deckalevel),
        par("Deckblevel", "Deck B Level", "Float", controlValues.mixer.Deckblevel),
        // RGB tuplet — color swatch + expandable per-channel sliders.
        par("Tintr", "Tint", "RGB", controlValues.mixer.Tintr, {
          tuplet: "Tint", tupletsize: 3, vecindex: 0,
        }),
        par("Tintg", "Tint", "RGB", controlValues.mixer.Tintg, {
          tuplet: "Tint", tupletsize: 3, vecindex: 1,
        }),
        par("Tintb", "Tint", "RGB", controlValues.mixer.Tintb, {
          tuplet: "Tint", tupletsize: 3, vecindex: 2,
        }),
      ],
    },
  ],
});

/* repoint (relative paths broken by a folder move, e.g. a Backup/ copy) */

const repointPlan = {
  ok: true,
  count: 2,
  in_backup_folder: true,
  project_folder: "C:/Shows/AuroraSet/Backup",
  project_file: "AuroraSet.14.toe",
  fixes: [
    {
      ref: "/AuroraSet/media/moviefilein_nebula.file",
      op: "/AuroraSet/media/moviefilein_nebula",
      par: "file",
      from: "media/Nebula_loop.mov",
      to: "../media/Nebula_loop.mov",
      file: "C:/Shows/AuroraSet/media/Nebula_loop.mov",
      name: "Nebula_loop.mov",
    },
    {
      ref: "/AuroraSet/audio/audiofilein_mix.file",
      op: "/AuroraSet/audio/audiofilein_mix",
      par: "file",
      from: "media/set_mix.wav",
      to: "../media/set_mix.wav",
      file: "C:/Shows/AuroraSet/media/set_mix.wav",
      name: "set_mix.wav",
    },
  ],
  unresolved: [
    {
      op: "/AuroraSet/media/moviefilein_old",
      par: "file",
      value: "media/retired_clip.mov",
      resolved: "C:/Shows/AuroraSet/Backup/media/retired_clip.mov",
    },
  ],
  skipped: [
    {
      op: "/AuroraSet/media/moviefilein_switch",
      par: "file",
      value: "media/a.mov",
      reason: "expression mode (not rewritten)",
    },
  ],
  counts: {},
};

/* collect (media consolidation) */

const collectPlan = {
  ok: true,
  files: [
    {
      src: "C:\\Assets\\Footage\\Nebula_loop.mov",
      dest: "collected\\video\\Nebula_loop.mov",
      category: "video",
      bytes: 734_000_000,
      pars: ["/AuroraSet/media/moviefilein_nebula.file"],
    },
    {
      src: "C:\\Assets\\Audio\\set_mix.wav",
      dest: "collected\\audio\\set_mix.wav",
      category: "audio",
      bytes: 88_200_000,
      pars: ["/AuroraSet/audio/audiofilein1.file"],
    },
    {
      src: "C:\\Users\\dan\\Pictures\\nordlys_logo.png",
      dest: "collected\\image\\nordlys_logo.png",
      category: "image",
      bytes: 2_100_000,
      pars: ["/AuroraSet/ui/top_logo.file"],
      frozen_pars: [
        { par: "/AuroraSet/ui/top_logo.file", expr: "app.samplesFolder + '/nordlys_logo.png'" },
      ],
    },
    {
      src: "C:\\Assets\\Models\\stage_deck.obj",
      dest: "collected\\geometry\\stage_deck.obj",
      category: "geometry",
      bytes: 14_600_000,
      pars: ["/AuroraSet/stage/filein_deck.file"],
    },
  ],
  normalize: [
    { op: "/AuroraSet/media/moviefilein_intro", par: "file", from: "C:/Demo/Projects/AuroraSet/media/intro.mp4", to: "media/intro.mp4" },
  ],
  skipped: [
    { op: "/AuroraSet/out/movieout1", par: "file", value: "out/render.mp4", reason: "output path" },
  ],
  counts: { video: 1, audio: 1, image: 1, geometry: 1 },
  count: 4,
  total_bytes: 838_900_000,
  freeze_count: 1,
};

let collectRun: { started: number; totalFiles: number; totalBytes: number } | null = null;

/* tdp packages */

const tdpPackages = [
  { name: "tdp-timecode", summary: "LTC/MTC timecode reader with drift compensation", version: "0.4.2" },
  { name: "tdp-oscquery", summary: "OSCQuery server exposing your parameters to any client", version: "1.1.0" },
  { name: "tdp-midimap", summary: "MIDI device layouts and mapping helpers", version: "0.9.7" },
  { name: "tdp-notchbridge", summary: "Notch block parameter bridge", version: "0.2.1" },
].map((p) => ({
  id: p.name,
  name: p.name,
  summary: p.summary,
  version: p.version,
  tags: ["touchdesigner"],
  homePage: `https://pypi.org/project/${p.name}/`,
  projectUrl: `https://pypi.org/project/${p.name}/`,
  spec: `${p.name}==${p.version}`,
  module: p.name.replace(/-/g, "_"),
  yanked: false,
}));

/* rclone / cloud */

let rclone = {
  available: false,
  version: null as string | null,
  path: null as string | null,
  config_path: `${HOME}\\AppData\\Roaming\\TDXLU\\rclone.conf`,
  remotes: [] as { name: string; provider: string }[],
};

/* readme */

const readmes = new Map<string, string>();
readmes.set(
  `${PROJ}\\AuroraSet\\AuroraSet.toe`,
  `# AuroraSet

Live AV set for the **Nordlys** tour.

## Rig
- 2× 4K outputs, NDI monitor feed
- MIDI: Launch Control XL (bank 2 = FX)
- Audio in on channels 1–2

## Show notes
- Cue 14 holds on the ribbon freeze until the MIDI release
- Blackout is \`Scene → blackout\`, **not** the master fader
- Collect media before every venue run (Companion → Collect)
`,
);

/* ────────────────────────── helpers ────────────────────────── */

function fileMeta(path: string) {
  const p = byPath(path);
  const known = p && !p.missing;
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  const dir = path.slice(0, path.length - name.length - 1);
  const secs = p ? p.mtimeSecs : daysAgo(3);
  const isTemplate = templates.includes(path);
  const exists = known || isTemplate || path.includes("Palette");
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    exists,
    name,
    dir,
    mtime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    mtime_secs: secs,
    bytes: p ? p.bytes : isTemplate ? 4_200_000 : 0,
  };
}

function projectMetaInfo(path: string) {
  const p = byPath(path);
  const name = p?.name ?? (path.replace(/\\/g, "/").split("/").pop() || path).replace(/\.toe$/i, "");
  // Flagship projects carry a rendered preview loop; the rest keep SVG art.
  const preview = p && !p.missing ? DEMO_PREVIEWS[name] : undefined;
  const hero = preview?.poster ?? (p && !p.missing ? heroArt(name) : null);
  return {
    project_path: path,
    sidecar_path: p && !p.missing ? `${p.dir}\\${name}.tdxlu.json` : null,
    meta: {
      version: 1,
      tags: p?.tags ?? [],
      title: null,
      description: p?.description || null,
      hero: null,
      media_dir: null,
      media: [],
    },
    hero_path: hero,
    media_folder: p && !p.missing ? `${p.dir}\\preview` : null,
    media: p && !p.missing
      ? preview
        ? [
            { path: preview.poster, kind: "image", caption: "preview.png", source: "folder" },
            { path: preview.video, kind: "video", caption: "preview.mp4", source: "folder" },
          ]
        : [
            { path: heroArt(name), kind: "image", caption: "preview.png", source: "folder" },
            { path: heroArt(name + " wide", `${name} — stage`), kind: "image", caption: "stage_wide.png", source: "folder" },
          ]
      : [],
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────── the dispatcher ────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/* companion autosave state, per session path */
type MockAutosave = {
  active: boolean;
  interval: number;
  mode: "td" | "overwrite";
  only_modified: boolean;
  skip_perform: boolean;
  status: string;
  last_save: number | null;
  next_in: number | null;
  modified: number;
  project_saved: boolean;
};
const autosaveByPath: Record<string, MockAutosave> = {};
function autosaveFor(path: string): MockAutosave {
  const key = normPath(path);
  if (!autosaveByPath[key]) {
    // AuroraSet ships armed so the row chip has something to show.
    const armed = /auroraset/i.test(path);
    autosaveByPath[key] = {
      active: armed,
      interval: 5,
      mode: "td",
      only_modified: true,
      skip_perform: true,
      status: armed ? "Saved 2 minutes ago" : "Autosave off",
      last_save: armed ? now() - 120 : null,
      next_in: armed ? 180 : null,
      modified: armed ? 3 : 0,
      project_saved: true,
    };
  }
  return autosaveByPath[key];
}

const handlers: Record<string, (args: Args) => any> = {
  /* app + prefs */
  get_app_info: () => ({
    version: "0.3.0",
    platform: "windows",
    default_template: "__default__",
    patreon_enabled: true,
    utility_version: "0.3.0",
    autostart_launch: false,
  }),
  get_config: () => ({ ...config }),
  update_prefs: (a) => {
    Object.assign(config, a.prefs);
    return { ...config };
  },
  merge_quick_seen_commands_cmd: (a) => {
    // Same union-by-identity as the real backend, so the demo's Settings
    // curation list fills in as the palette is opened.
    const seen = [...((config as any).quick_seen_commands ?? [])];
    let added = 0;
    for (const c of (a.cmds ?? []) as any[]) {
      const at = seen.findIndex((e: any) => e.identity === c.identity);
      if (at >= 0) seen[at] = { ...seen[at], ...c };
      else {
        seen.push(c);
        added++;
      }
    }
    (config as any).quick_seen_commands = seen;
    return added;
  },
  export_settings_cmd: () => `${HOME}\\Desktop\\tdxlu-settings.json`,
  import_settings_cmd: () => null, // "dialog cancelled"
  get_cli_toe_file: () => null,
  get_hotkey_status: () => null,
  get_hotkey_status_quick_alt: () => null,
  get_hotkey_status_main_alt: () => null,
  set_hotkey_enabled_cmd: () => null,
  get_hotkey_status_main: () => null,
  set_hotkey_enabled_main_cmd: () => null,
  get_hotkey_status_palette: () => null,
  set_hotkey_enabled_palette_cmd: () => null,
  restart_app: () => window.location.reload(),
  quit_app: () => undefined,
  show_main_window: () => undefined,
  get_bundled_utility_tox: () => "C:\\Program Files\\TDXLU\\resources\\utility\\TDXLauncherUtility.tox",
  install_bundled_utility_cmd: () => `${PALETTE_USER}\\TDXLU\\TDXLauncherUtility.tox`,
  // The demo is always current — an update prompt on a canned tour would be noise.
  check_utility_update_cmd: () => ({
    available: false,
    installed: true,
    currentVersion: "0.3.0",
    latestVersion: "0.3.0",
    notes: "",
  }),
  install_utility_update_cmd: () => "0.3.0",
  write_temp_html: () => "C:\\Temp\\tdxlu-view.html",
  alert_test_email_cmd: () => "Test email sent to vj@nordlys.demo",
  open_path: () => undefined,
  open_url: (a) => {
    const url = String(a?.url ?? "");
    if (/^https:\/\//.test(url)) window.open(url, "_blank", "noopener");
  },
  open_control_server_cmd: () => "http://127.0.0.1:9801/?token=demo",

  /* GPU affinity — a two-monitor demo rig so the submenu has something to show
     (a missing handler resolves null and used to crash the row context menu) */
  list_gpu_monitors: () => [
    { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: "Display 1" },
    { index: 1, x: 1920, y: 0, width: 3840, height: 2160, primary: false, name: "Display 2" },
  ],

  /* versions */
  discover_versions: () => ({
    versions: [...INSTALLED, ...[...installedKeys].filter((k) => !INSTALLED.some((v) => v.key === k)).map((key) => ({ key, executable: `C:\\Program Files\\Derivative\\${key}\\bin\\TouchDesigner.exe` }))].map((v) => ({
      ...v,
      install_path: v.executable.replace(/\\bin\\.*$/, ""),
      app_path: null,
      bundle_version: null,
    })),
    players: PLAYERS.map((v) => ({ ...v, install_path: v.executable.replace(/\\bin\\.*$/, ""), app_path: null, bundle_version: null })),
  }),
  inspect_toe: async (a) => {
    await delay(350); // feel the analysis step
    const p = byPath(a.path);
    if (p) return p.build;
    if (templates.includes(a.path)) return "TouchDesigner.2025.30060";
    return null;
  },
  check_version_installed: (a) => {
    const key = a.useTouchplayer ? `TouchPlayer.${a.version.replace(/^Touch(Designer|Player)\./, "")}` : a.version;
    return a.useTouchplayer ? PLAYERS.some((p) => p.key === key) : installedKeys.has(a.version);
  },
  rediscover_and_check: (a) => handlers.check_version_installed(a),
  get_download_url: (a) => `https://download.derivative.ca/${a.buildOption}.64-Bit.exe`,
  download_td: async () => {
    for (let pct = 0; pct <= 100; pct += 4) {
      emitMock("download-progress", { progress: pct });
      await delay(90);
    }
  },
  open_installer: async (a) => {
    // "Running" the installer makes the missing build appear installed.
    await delay(600);
    const m = String(a.path).match(/TouchDesigner\.\d{4}\.\d+/);
    if (m) installedKeys.add(m[0]);
  },

  /* recents + templates */
  get_recents: () => recents.map((r) => ({ ...r })),
  add_recent: (a) => {
    recents = [{ path: a.path, source: "launcher", last_opened: now() }, ...recents.filter((r) => r.path !== a.path)];
  },
  remove_recent: (a) => {
    recents = recents.filter((r) => r.path !== a.path);
  },
  clear_recents: () => {
    recents = [];
  },
  clear_missing: () => {
    const before = recents.length;
    recents = recents.filter((r) => !byPath(r.path)?.missing);
    return before - recents.length;
  },

  /* phone remote */
  phone_remote_start_cmd: () => {
    phoneServing = true;
    return "http://192.168.1.42:11997/#k=demotoken0000demotoken0000demo";
  },
  phone_remote_client_url_cmd: () => {
    phoneServing = true;
    return "http://192.168.1.42:11997/#k=clientdemo0000clientdemo0000cl";
  },
  control_regenerate_token_cmd: () => undefined,
  control_server_stop_cmd: () => {
    phoneServing = false;
  },
  control_server_status_cmd: () => ({ running: phoneServing, lan: phoneServing, port: 11997 }),

  /* quick-launch overlay */
  open_quick_cmd: () => undefined,
  patreon_cached_tox_cmd: () => [
    { name: "FeedbackSculptor.tox", path: "C:\\Demo\\Patreon\\alta_v\\a1b2\\FeedbackSculptor.tox", creator: "alta_v" },
    { name: "SDFBlobs.tox", path: "C:\\Demo\\Patreon\\alta_v\\c3d4\\SDFBlobs.tox", creator: "alta_v" },
    { name: "MidiGridPro.tox", path: "C:\\Demo\\Patreon\\function.store\\e5f6\\MidiGridPro.tox", creator: "function.store" },
  ],

  /* variant families */
  list_project_families_cmd: () => mockFamilies(),
  create_variant_cmd: (a) => {
    const sourcePath = String(a.sourcePath);
    // Find the family this source belongs to, or — for a project with no
    // recorded variants yet — synthesize one from its plain project entry
    // and persist it, exactly like the real scanner would pick it up.
    let dirKey = Object.keys(variantFamilies).find((dir) =>
      variantFamilies[dir].some((v) => normPath(v.path) === normPath(sourcePath)),
    );
    let vs: MockVariant[];
    if (dirKey) {
      vs = variantFamilies[dirKey];
    } else {
      const proj = projects.find((p) => normPath(p.path) === normPath(sourcePath));
      if (!proj) throw new Error(`File not found: ${sourcePath}`);
      dirKey = proj.dir;
      vs = [
        { path: proj.path, kind: "head", ordinal: null, modified: proj.mtimeSecs, size: proj.bytes },
      ];
      variantFamilies[dirKey] = vs;
    }
    const source = vs.find((v) => normPath(v.path) === normPath(sourcePath));
    if (!source) throw new Error(`File not found: ${sourcePath}`);
    const head = vs.find((v) => v.kind === "head");
    const baseName = head
      ? (head.path.replace(/\\/g, "/").split("/").pop() || "").replace(/\.toe$/i, "")
      : "Project";
    const nextN = Math.max(0, ...vs.map((v) => v.ordinal ?? 0)) + 1;
    const created: MockVariant = {
      path: `${dirKey}\\${baseName}.${nextN}.toe`,
      kind: "increment",
      ordinal: nextN,
      modified: now(),
      size: source.size,
    };
    vs.push(created);
    return created;
  },
  create_safe_mode_copy_cmd: (a) => {
    // Mirrors variants::create_safe_mode_copy — copy to a CrashAutoSave.
    // sibling, never overwriting one without an explicit yes.
    const sourcePath = String(a.sourcePath);
    const overwrite = a.overwrite === true;
    const fileName = sourcePath.replace(/\\/g, "/").split("/").pop() || "";
    if (/^crashautosave\./i.test(fileName)) {
      throw new Error(`${fileName} already opens in Safe Mode`);
    }
    const dir = sourcePath.slice(0, sourcePath.length - fileName.length - 1);
    const targetPath = `${dir}\\CrashAutoSave.${fileName}`;
    const vs = variantFamilies[dir];
    const existing = vs?.find((v) => normPath(v.path) === normPath(targetPath));
    if (existing && !overwrite) {
      return {
        path: targetPath,
        needs_confirm: true,
        existing_modified: existing.modified,
        replaced: false,
      };
    }
    const source =
      vs?.find((v) => normPath(v.path) === normPath(sourcePath)) ??
      projects.find((p) => normPath(p.path) === normPath(sourcePath));
    if (!source) throw new Error(`File not found: ${sourcePath}`);
    const size = "size" in source ? source.size : source.bytes;
    if (existing) {
      existing.modified = now();
      existing.size = size;
    } else {
      const created: MockVariant = {
        path: targetPath,
        kind: "crash",
        ordinal: null,
        modified: now(),
        size,
      };
      if (vs) vs.push(created);
      else variantFamilies[dir] = [created];
    }
    return {
      path: targetPath,
      needs_confirm: false,
      existing_modified: null,
      replaced: !!existing,
    };
  },
  restore_variant_as_head_cmd: (a) => {
    const variantPath = String(a.variantPath);
    const fam = Object.entries(variantFamilies).find(([, vs]) =>
      vs.some((v) => normPath(v.path) === normPath(variantPath)),
    );
    if (!fam) throw new Error(`File not found: ${variantPath}`);
    const [dir, vs] = fam;
    const variant = vs.find((v) => normPath(v.path) === normPath(variantPath))!;
    if (variant.kind === "head") throw new Error("This file already is the project head");
    const head = vs.find((v) => v.kind === "head");
    let preserved: string | null = null;
    if (head) {
      const nextN = Math.max(0, ...vs.map((v) => v.ordinal ?? 0)) + 1;
      const base = (head.path.replace(/\\/g, "/").split("/").pop() || "").replace(/\.toe$/i, "");
      preserved = `${dir}\\${base}.${nextN}.toe`;
      vs.push({ ...head, path: preserved, kind: "increment", ordinal: nextN });
      head.modified = now();
      head.size = variant.size;
    } else {
      vs.push({ ...variant, path: `${dir}\\restored.toe`, kind: "head", ordinal: null });
    }
    const proj = projects.find((p) => p.dir === dir);
    if (proj) {
      proj.mtimeSecs = now();
      proj.bytes = variant.size;
    }
    return { head: head?.path ?? `${dir}\\restored.toe`, preserved_as: preserved };
  },
  trash_variants_cmd: (a) => {
    const paths = (a.paths as string[]).map(normPath);
    let bytes = 0;
    for (const vs of Object.values(variantFamilies)) {
      for (const v of vs) {
        if (paths.includes(normPath(v.path))) {
          if (v.kind === "head") throw new Error("Refusing to delete a project head");
          bytes += v.size;
        }
      }
    }
    for (const key of Object.keys(variantFamilies)) {
      variantFamilies[key] = variantFamilies[key].filter((v) => !paths.includes(normPath(v.path)));
    }
    return bytes;
  },
  get_templates: () => [...templates],
  add_template: (a) => {
    if (!templates.includes(a.path)) templates.push(a.path);
  },
  remove_template: (a) => {
    templates = templates.filter((t) => t !== a.path);
  },
  move_template: (a) => {
    const i = templates.indexOf(a.path);
    const j = a.direction === "up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < templates.length) {
      [templates[i], templates[j]] = [templates[j], templates[i]];
    }
  },
  import_plus_templates_cmd: () => ({ imported: 0, total: 0, source: "TD Launcher Plus" }),

  /* project metadata */
  get_icon_data_url: (a) => {
    const p = byPath(a.path);
    if (p?.missing) return null;
    const name = (String(a.path).replace(/\\/g, "/").split("/").pop() || "?").replace(/\.(toe|tox)$/i, "");
    return projectIcon(name);
  },
  get_project_meta: (a) => projectMetaInfo(a.path),
  get_projects_meta: (a) => (a.paths as string[]).map(projectMetaInfo),
  get_all_tags: () => [...new Set(projects.flatMap((p) => p.tags))].sort(),
  save_project_meta_cmd: (a) => {
    const p = byPath(a.path);
    if (p) {
      p.tags = a.meta.tags ?? p.tags;
      p.description = a.meta.description ?? p.description;
    }
    return p ? `${p.dir}\\${p.name}.tdxlu.json` : "";
  },
  get_file_meta_cmd: (a) => fileMeta(a.path),
  get_files_meta_cmd: (a) => (a.paths as string[]).map(fileMeta),
  get_readme: (a) => {
    const content = readmes.get(a.path) ?? "";
    return {
      path: content ? a.path.replace(/[^\\]+$/, "README.md") : null,
      content,
      summary: content.split("\n").find((l) => l && !l.startsWith("#")) ?? "",
    };
  },
  save_readme_cmd: (a) => {
    readmes.set(a.projectPath, a.content);
    return a.projectPath.replace(/[^\\]+$/, "README.md");
  },

  /* launching + sessions */
  launch_project: async (a) => {
    await delay(900);
    const p = byPath(a.path);
    const name = p?.name ?? (a.path.replace(/\\/g, "/").split("/").pop() || a.path).replace(/\.toe$/i, "");
    const pid = nextPid++;
    const windows = [
      win(80000 + pid, pid, `${name} - ${String(a.versionKey).replace("TouchDesigner.", "TouchDesigner ")}`),
    ];
    const instance: SessionInstance = { pid, source: "launcher", started_at: now(), windows };
    // Launching a project that's ALREADY running doesn't make a second row —
    // it makes a second process on the one row, exactly as the real hub keys
    // sessions by .toe path. Nothing here (or in TD) prevents it.
    const live = sessions.find((s) => s.alive && normPath(s.path) === normPath(a.path));
    if (live) {
      live.instances = [...live.instances, instance];
      live.windows = live.instances.flatMap((i) => i.windows);
    } else {
      sessions = [
        {
          id: `sess-${pid}`,
          path: a.path,
          display_name: name,
          pid,
          alive: true,
          version_key: a.versionKey,
          use_touchplayer: a.useTouchplayer,
          envoy_port: null,
          envoy_up: null,
          mcp_available: false,
          utility_available: p?.name === "AuroraSet" ? true : null,
          utility_version: p?.name === "AuroraSet" ? "0.3.0" : null,
          source: "launcher",
          started_at: now(),
          windows,
          instances: [instance],
        },
        ...sessions,
      ];
    }
    if (a.promote !== false) handlers.add_recent({ path: a.path });
  },
  open_projects_list_cmd: () => sessions.map((s) => ({ ...s })),
  open_project_kill_cmd: (a) => {
    // Match the real hub: killing leaves a stale, relaunchable tombstone — and
    // for an externally-opened session (no recorded build) the build is
    // resolved from the .toe so it stays relaunchable. But a project open more
    // than once only goes stale when its LAST process dies; killing one of two
    // just drops that instance and promotes the survivor.
    sessions = sessions.map((s) => {
      if (!s.instances.some((i) => i.pid === a.pid)) return s;
      const left = s.instances.filter((i) => i.pid !== a.pid);
      if (left.length) {
        return {
          ...s,
          instances: left,
          pid: left[0].pid,
          windows: left.flatMap((i) => i.windows),
        };
      }
      return {
        ...s,
        alive: false,
        pid: null,
        ended_at: now(),
        version_key: s.version_key ?? byPath(s.path)?.build ?? null,
        windows: [],
        instances: [],
        envoy_port: null,
        envoy_up: null,
        utility_available: null,
      };
    });
    return sessions.map((s) => ({ ...s }));
  },
  open_project_dismiss_cmd: (a) => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    sessions = sessions.filter((s) => norm(s.path) !== norm(String(a.path)));
    return sessions.map((s) => ({ ...s }));
  },
  open_project_focus_cmd: () => undefined,
  /* shared command usage (command-usage.json) — two commands this demo
     "has run a lot", so the bare ">" / "?" lists show ranking by usage */
  command_usage_bonuses: () => ({ "GlobalVolControl#mute": 6.1, "QuickTime#tap": 3.4 }),
  command_usage_record: () => undefined,
  command_usage_clear: () => undefined,
  open_project_relaunch_cmd: async (a) => {
    // With kill-first, relaunch replaces any prior entry for that path (live or
    // tombstone). WITHOUT it, the old process keeps running and this is really
    // a second copy — launch_project then merges it onto the same row.
    if (a.killFirst !== false) {
      sessions = sessions.filter((s) => normPath(s.path) !== normPath(String(a.path)));
    } else {
      // Relaunching a tombstone (its process is already gone): the ended row
      // is superseded — drop it or launch_project leaves a duplicate, since
      // it only merges onto LIVE rows.
      sessions = sessions.filter((s) => s.alive || normPath(s.path) !== normPath(String(a.path)));
    }
    await handlers.launch_project({ path: a.path, versionKey: a.versionKey, useTouchplayer: a.useTouchplayer, promote: false });
    return sessions.map((s) => ({ ...s }));
  },
  session_windows_list_cmd: (a) => {
    // A pid addresses one PROCESS, which may be the second instance of a
    // project rather than the one leading its row.
    if (a.pid != null) {
      const inst = sessions.flatMap((s) => s.instances).find((i) => i.pid === a.pid);
      return (inst?.windows ?? []).map((w) => ({ ...(w as object) }));
    }
    return sessions.flatMap((s) => s.windows.map((w) => ({ ...(w as object) })));
  },
  session_window_action_cmd: () => undefined,
  session_windows_bulk_cmd: () => undefined,
  sessions_perf_cmd: (a) => {
    const out: Record<string, { cpu_pct: number; mem_mb: number }> = {};
    for (const pid of a.pids as number[]) {
      const base = pid === 20918 ? 31 : 12;
      out[String(pid)] = {
        cpu_pct: Math.round((base + Math.random() * 4) * 10) / 10,
        mem_mb: Math.round(1600 + (pid % 1000) + Math.random() * 120),
      };
    }
    return out;
  },

  /* companion utility */
  open_project_utility_cmd: async (a) => {
    const action = a.action as string;
    const sess = sessions.find((s) => s.path === a.path);
    if (!sess || sess.utility_available === false) {
      return { ok: false, error: "Companion utility not reachable in this session." };
    }
    switch (action) {
      case "autosave_get":
        return { ok: true, ...autosaveFor(String(a.path)) };
      case "autosave_set": {
        const st = autosaveFor(String(a.path));
        const f = (((a.payload ?? {}) as Record<string, unknown>).fields ?? {}) as Record<string, unknown>;
        if (typeof f.active === "boolean") st.active = f.active;
        if (typeof f.interval === "number") st.interval = f.interval;
        if (typeof f.mode === "string") st.mode = f.mode as "td" | "overwrite";
        if (typeof f.only_modified === "boolean") st.only_modified = f.only_modified;
        if (typeof f.skip_perform === "boolean") st.skip_perform = f.skip_perform;
        st.status = st.active
          ? `Armed — next save in ${st.interval}m`
          : "Autosave off";
        return { ok: true, ...st };
      }
      case "perf":
        return {
          ok: true,
          fps: 59.4 + Math.random() * 1.2,
          cook_rate: 60,
          cook_ms: 9.2 + Math.random() * 2.5,
          dropped: 0,
          gpu_mem_mb: 2214,
          gpu_mem_total_mb: 12288,
          cpu_mem_mb: 1843,
        };
      case "control_schema":
        return controlSchema();
      case "control_get":
        return {
          ok: true,
          targets: [
            ...(laserAdded
              ? [{ key: "block1", path: "/AuroraSet/lasers", values: { ...controlValues.lasers } }]
              : []),
            { key: "perform", path: "/AuroraSet/perform", values: { ...controlValues.perform } },
            { key: "mixer", path: "/AuroraSet/mixer", values: { ...controlValues.mixer } },
          ],
        };
      case "control_set": {
        const sets = (a.payload?.sets ?? []) as { target: string; par: string; value: unknown }[];
        const results = sets.map((s) => {
          const bucket = controlValues[s.target === "block1" ? "lasers" : s.target];
          if (bucket) bucket[s.par] = s.value;
          return { target: s.target, par: s.par, ok: true, value: s.value };
        });
        return { ok: true, results };
      }
      case "control_comps":
        return controlComps(a.payload?.parent as string | undefined);
      case "control_add": {
        const comp = String(a.payload?.comp ?? "");
        if (comp === "/AuroraSet/lasers") {
          laserAdded = true;
          return { ok: true, key: "block1" };
        }
        if (comp === "/AuroraSet/mixer") return { ok: true, already: true, key: "block0" };
        return { ok: false, error: "demo: only lasers can be exposed here" };
      }
      case "control_remove": {
        if (String(a.payload?.key ?? "") === "block1") {
          laserAdded = false;
          return { ok: true };
        }
        return { ok: false, error: "demo: only the lasers block is removable" };
      }
      case "repoint_assets": {
        if (a.payload?.dry_run) {
          await delay(400);
          return { ...repointPlan };
        }
        const include =
          (a.payload?.include as string[] | undefined) ?? repointPlan.fixes.map((f) => f.ref);
        const applied = repointPlan.fixes.filter((f) => include.includes(f.ref));
        return {
          ok: true,
          saved: false,
          count: applied.length,
          attempted: applied.length,
          errors: [],
          applied,
        };
      }
      case "collect_save": {
        if (a.payload?.dry_run) {
          await delay(700);
          return { ...collectPlan };
        }
        const include = (a.payload?.include as string[] | undefined) ?? collectPlan.files.map((f) => f.src);
        const files = collectPlan.files.filter((f) => include.includes(f.src));
        collectRun = {
          started: Date.now(),
          totalFiles: files.length,
          totalBytes: files.reduce((s, f) => s + f.bytes, 0),
        };
        return { ok: true, started: true };
      }
      case "collect_status": {
        if (!collectRun) return { ok: true, phase: "idle" };
        const t = (Date.now() - collectRun.started) / 1000;
        if (t < 2.2) {
          const frac = Math.min(1, t / 2.2);
          return {
            ok: true,
            phase: "copying",
            total_files: collectRun.totalFiles,
            done_files: Math.floor(frac * collectRun.totalFiles),
            total_bytes: collectRun.totalBytes,
            done_bytes: Math.floor(frac * collectRun.totalBytes),
            current: collectPlan.files[Math.min(collectPlan.files.length - 1, Math.floor(frac * collectRun.totalFiles))]?.src,
          };
        }
        if (t < 2.9) return { ok: true, phase: "rewriting", rewrites: 5 };
        if (t < 3.4) return { ok: true, phase: "saving" };
        return {
          ok: true,
          phase: "done",
          total_files: collectRun.totalFiles,
          done_files: collectRun.totalFiles,
          total_bytes: collectRun.totalBytes,
          done_bytes: collectRun.totalBytes,
          rewrites: 5,
          failed: 0,
          frozen_count: 1,
        };
      }
      case "load_tox":
        await delay(700);
        return { ok: true };
      case "fns_status":
        await delay(250);
        return fnsDemoSessionStatus();
      case "fns_install": {
        await delay(600);
        // The picked tools were recorded by fns_write_selection_cmd; "land"
        // them after a couple of polls so the progress state shows.
        const sel = [...fnsState.lastSelection];
        const versions = new Map(
          fnsDemoManifest().packages.map((p) => [p.name, p.version]),
        );
        setTimeout(() => {
          fnsState.installed = new Map(
            sel.map((n) => [n, versions.get(n) ?? "1.0.0"]),
          );
        }, 5000);
        return {
          ok: true,
          started: true,
          root: "/FNSTools",
          installer: "/FNSTools/FNS_Installer",
          bootstrapped: fnsState.installed.size === 0,
          pulse_in_frames: 90,
        };
      }
      case "fns_settings_url":
        await delay(300);
        fnsState.settingsServed = true;
        return { ok: true, url: "http://127.0.0.1:9871/" };
      case "fns_commands":
        // Tool-announced quick-launch commands (FNS_CommandRegistry).
        await delay(150);
        return {
          ok: true,
          rev: 3,
          commands: [
            // A multi-instance tool (registry >= 1.11.0): two copies of one
            // tool register the same ids on different paths. `tool` comes
            // from FnsToolName() so both curate as "Scope"; `instance` from
            // FnsInstance() tells the rows apart.
            ...[
              ["/project1/scope_main", "Main out", true],
              ["/project1/scope_preview", "Preview", false],
            ].flatMap(([path, instance, frozen]) => [
              {
                key: `${path}#freeze`,
                tool: "Scope",
                id: "freeze",
                label: "Freeze scope",
                help: "Hold the current frame",
                path: path as string,
                instance: instance as string,
                state: frozen as boolean,
              },
              {
                key: `${path}#set_gain`,
                tool: "Scope",
                id: "set_gain",
                label: "Set scope gain",
                help: "Scale the scope's input",
                path: path as string,
                instance: instance as string,
                state: "1",
                params: [{ name: "gain", label: "Gain", style: "float", default: 1.0 }],
              },
            ]),
            {
              key: "/FNSTools/HydroHomie#toggle",
              tool: "HydroHomie",
              id: "toggle",
              label: "Toggle HydroHomie",
              help: "Show or hide the hydration reminder overlay",
              path: "/FNSTools/HydroHomie",
              // Live state (registry ≥ 1.6.0): evaluated at fetch time.
              state: true,
              // Surface targeting (registry ≥ 1.7.0): also rendered on the
              // Current bar and the session context menu.
              surface: ["session", "context-menu"],
            },
            {
              key: "/FNSTools/QuickTime#tap",
              tool: "QuickTime",
              id: "tap",
              label: "Tap tempo",
              help: "Tap the project BPM",
              path: "/FNSTools/QuickTime",
            },
            {
              key: "/FNSTools/QuickTime#set_bpm",
              tool: "QuickTime",
              id: "set_bpm",
              label: "Set BPM",
              help: "Set the project tempo",
              path: "/FNSTools/QuickTime",
              state: "128",
              params: [
                {
                  name: "bpm",
                  label: "BPM",
                  style: "float",
                  required: true,
                  default: 120,
                  help: "Beats per minute",
                  // Live prefill: the prompt opens holding this, not blank.
                  current: "128",
                },
                { name: "sync", label: "Resync clips", style: "toggle", default: false },
              ],
              // Session-surface command WITH params — exercises the
              // argument-prompt modal from the Current bar.
              surface: ["session"],
            },
            {
              key: "/FNSTools/GlobalVolControl#mute",
              tool: "GlobalVolControl",
              id: "mute",
              label: "Mute master volume",
              help: "",
              path: "/FNSTools/GlobalVolControl",
              state: false,
              surface: ["context-menu"],
            },
            {
              key: "/FNSTools/QuickTime#debug_dump",
              tool: "QuickTime",
              id: "debug_dump",
              label: "Dump tempo debug state",
              help: "Advanced: log the tempo engine internals",
              path: "/FNSTools/QuickTime",
              hidden: true,
            },
            {
              key: "/TDXLauncherUtility/TD_UI#opentextport",
              tool: "TD_UI",
              id: "opentextport",
              label: "Open Textport",
              help: "Open the Textport.",
              path: "/TDXLauncherUtility/TD_UI",
              builtin: true,
            },
            // Blessed capabilities (registry ≥ 1.7.0): recognised ids swap
            // in the launcher's rich UI; the hidden verbs are what that UI
            // drives through fns_run_command.
            {
              key: "/TDXLauncherUtility/TDXLUCollect#collect",
              tool: "TDXLUCollect",
              id: "collect",
              label: "Collect All & Save…",
              help: "Scan external file refs (dry-run plan; nothing is copied)",
              path: "/TDXLauncherUtility/TDXLUCollect",
              surface: ["session", "context-menu"],
              capability: "fns.collect",
            },
            {
              key: "/TDXLauncherUtility/TDXLUCollect#apply",
              tool: "TDXLUCollect",
              id: "apply",
              label: "Collect: apply plan",
              path: "/TDXLauncherUtility/TDXLUCollect",
              hidden: true,
              capability: "fns.collect",
            },
            {
              key: "/TDXLauncherUtility/TDXLUCollect#status",
              tool: "TDXLUCollect",
              id: "status",
              label: "Collect: status",
              path: "/TDXLauncherUtility/TDXLUCollect",
              hidden: true,
              capability: "fns.collect",
            },
            {
              key: "/FNSTools/FNS_Autosave#autosave",
              tool: "FNS_Autosave",
              id: "autosave",
              label: "Autosave...",
              help: "Save this project on a timer, from inside TouchDesigner",
              path: "/FNSTools/FNS_Autosave",
              state: true,
              surface: ["session", "context-menu"],
              capability: "fns.autosave",
            },
            {
              key: "/FNSTools/FNS_Autosave#autosave_get",
              tool: "FNS_Autosave",
              id: "autosave_get",
              label: "Autosave: settings",
              path: "/FNSTools/FNS_Autosave",
              hidden: true,
              capability: "fns.autosave",
            },
            {
              key: "/FNSTools/FNS_Autosave#autosave_set",
              tool: "FNS_Autosave",
              id: "autosave_set",
              label: "Autosave: write settings",
              path: "/FNSTools/FNS_Autosave",
              hidden: true,
              capability: "fns.autosave",
            },
            {
              key: "/FNSTools/FNS_Autosave#autosave_now",
              tool: "FNS_Autosave",
              id: "autosave_now",
              label: "Save now",
              path: "/FNSTools/FNS_Autosave",
              hidden: true,
              capability: "fns.autosave",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#media",
              tool: "TDXLUMedia",
              id: "media",
              label: "Media Browser…",
              help: "List every media file reference in the project",
              path: "/TDXLauncherUtility/TDXLUMedia",
              surface: ["session", "context-menu"],
              capability: "fns.media-browser",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#list",
              tool: "TDXLUMedia",
              id: "list",
              label: "Media: list refs",
              path: "/TDXLauncherUtility/TDXLUMedia",
              hidden: true,
              capability: "fns.media-browser",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#replace",
              tool: "TDXLUMedia",
              id: "replace",
              label: "Media: replace ref",
              path: "/TDXLauncherUtility/TDXLUMedia",
              hidden: true,
              capability: "fns.media-browser",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#probe",
              tool: "TDXLUMedia",
              id: "probe",
              label: "Media: probe ref",
              path: "/TDXLauncherUtility/TDXLUMedia",
              hidden: true,
              capability: "fns.media-browser",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#sync_timeline",
              tool: "TDXLUMedia",
              id: "sync_timeline",
              label: "Media: sync timeline to clip",
              path: "/TDXLauncherUtility/TDXLUMedia",
              hidden: true,
              capability: "fns.media-browser",
            },
            {
              key: "/TDXLauncherUtility/TDXLUMedia#unreferenced",
              tool: "TDXLUMedia",
              id: "unreferenced",
              label: "Media: unreferenced files",
              path: "/TDXLauncherUtility/TDXLUMedia",
              hidden: true,
              capability: "fns.media-browser",
            },
          ],
        };
      case "fns_run_command": {
        await delay(400);
        const p = a.payload as { key?: string; kwargs?: Record<string, unknown> } | null;
        const key = p?.key ?? "";
        const kw = p?.kwargs ?? {};
        // Blessed-capability keys answer exactly like their legacy verbs —
        // the two rails must be indistinguishable to the rich UI.
        const reroute: Record<string, [string, Record<string, unknown> | null]> = {
          "/TDXLauncherUtility/TDXLUCollect#collect": ["collect_save", { dry_run: true }],
          "/TDXLauncherUtility/TDXLUCollect#apply": ["collect_save", kw],
          "/TDXLauncherUtility/TDXLUCollect#status": ["collect_status", null],
          "/FNS_Autosave#autosave": ["autosave_get", null],
          "/FNSTools/FNS_Autosave#autosave": ["autosave_get", null],
          "/FNSTools/FNS_Autosave#autosave_get": ["autosave_get", null],
          "/FNSTools/FNS_Autosave#autosave_set": ["autosave_set", kw],
          "/FNSTools/FNS_Autosave#autosave_now": ["autosave_now", null],
          "/TDXLauncherUtility/TDXLUMedia#media": ["media_list", null],
          "/TDXLauncherUtility/TDXLUMedia#list": ["media_list", null],
          "/TDXLauncherUtility/TDXLUMedia#replace": ["media_replace", kw],
          "/TDXLauncherUtility/TDXLUMedia#probe": ["media_probe", kw],
          "/TDXLauncherUtility/TDXLUMedia#sync_timeline": ["media_sync", kw],
          "/TDXLauncherUtility/TDXLUMedia#unreferenced": ["media_unreferenced", kw],
        };
        const hit = reroute[key];
        if (hit) {
          return handlers.open_project_utility_cmd({
            ...a,
            action: hit[0],
            payload: hit[1],
          });
        }
        return { ok: true, key, kwargs: p?.kwargs ?? null };
      }
      case "ensure_pyenv": {
        // One-click env: a demo "creation" that finishes a few seconds later.
        await delay(400);
        const dir = byPath(String(a.path ?? ""))?.dir ?? "C:\\Demo";
        if (byPath(String(a.path ?? ""))?.name === "AuroraSet") {
          return { ok: true, already: true, path: "/tdPyEnvManager", env_ready: true, creating: false, env_path: `${dir}\\.venv` };
        }
        (globalThis as any).__pyenvStarted = Date.now();
        return { ok: true, already: false, path: "/tdPyEnvManager", creating: true, env_path: `${dir}\\.venv` };
      }
      case "pyenv_status": {
        const t0 = (globalThis as any).__pyenvStarted ?? 0;
        const done = Date.now() - t0 > 4000;
        return {
          ok: true, manager: "/tdPyEnvManager", active: true,
          status: done ? "Environment linked and ready." : "Creating Python vEnv...",
          state: done ? "ready" : "creating",
        };
      }
      case "ensure_tdpyenv": {
        await delay(500);
        return { ok: true, already: false, path: "/tdPyEnvManager", parent: "/" };
      }
      default:
        // save / snapshot / record / update_utility / …
        await delay(600);
        return { ok: true };
    }
  },

  /* FNS tools store + configurator */
  fns_manifest_cmd: async (a) => {
    await delay(a.refresh ? 700 : 150);
    return {
      manifest: fnsDemoManifest(),
      source: a.refresh ? "network" : "cache",
      baseUrl: "https://storage.functionstore.tools/fnstools",
    };
  },
  fns_store_status_cmd: () => fnsDemoStoreStatus(),
  fns_sync_store_cmd: async (a) => {
    const names = (a.names as string[] | null) ?? fnsDemoManifest().packages.map((p) => p.name);
    const total = names.length;
    for (let i = 0; i < total; i++) {
      emitMock("transfer-progress", {
        op_id: "fns-store",
        done: i,
        total,
        bytes: i * 68470,
        total_bytes: total * 68470,
        detail: `${names[i]}.tox`,
      });
      await delay(90);
      fnsState.inStore.add(names[i]);
      fnsState.stale.delete(names[i]);
    }
    if (a.includeRails) {
      fnsState.railsInStore.add("FNSTools");
      fnsState.railsInStore.add("FNS_Installer");
    }
    emitMock("transfer-progress", {
      op_id: "fns-store",
      done: total,
      total,
      bytes: total * 68470,
      total_bytes: total * 68470,
      detail: "",
    });
    return fnsDemoStoreStatus();
  },
  fns_write_selection_cmd: (a) => {
    fnsState.lastSelection = [...((a.tools as string[]) ?? [])];
    return `${fnsDemoStoreStatus().storeDir.replace(/\\/g, "/")}/selection.json`;
  },
  fns_config_read_cmd: () => fnsDemoConfig(),
  fns_config_write_cmd: () => undefined,
  fns_settings_state_cmd: () => fnsDemoUiState(),
  fns_settings_scope_cmd: async (a) => {
    await delay(120);
    return fnsDemoSetScope(a.value, a.mode);
  },
  fns_settings_set_cmd: async (a) => {
    await delay(150);
    return { ok: true, val: a.value };
  },

  /* palette + toolbox */
  default_palette_dir_cmd: () => PALETTE_USER,
  get_drag_icon_path: () => "icon.png",
  get_palette_items_cmd: () => [...paletteItems, ...factoryPalette].map((i) => ({ ...i })),
  palette_scan_info_cmd: () => [
    { label: "User Palette", path: PALETTE_USER, exists: true, readable: true, tox_count: paletteItems.length },
    { label: "Derivative", path: PALETTE_TD, exists: true, readable: true, tox_count: factoryPalette.length },
  ],
  import_tox_to_palette_cmd: (a) => ({
    copied: a.paths,
    skipped: [],
    dest_dir: a.destFolder ? `${PALETTE_USER}\\${a.destFolder}` : PALETTE_USER,
    palette_data_updated: true,
  }),
  remove_palette_file_cmd: () => undefined,
  rebuild_palette_data_cmd: () => "Palette data rebuilt (demo)",
  toolbox_get_cmd: () => toolboxView(),
  toolbox_seed_bundled_cmd: () => toolboxView(),
  toolbox_add_tool_cmd: (a) => {
    toolboxTools.push({
      id: `tool-${nextToolId++}`,
      label: a.label || a.source.replace(/\\/g, "/").split("/").pop() || a.source,
      kind: a.kind,
      source: a.source,
      category: a.category ?? "",
      notes: a.notes ?? "",
      resolvedPath: a.kind === "local" ? a.source : null,
      missing: false,
    });
    if (a.category && !toolboxCategories.includes(a.category)) toolboxCategories.push(a.category);
    return toolboxView();
  },
  toolbox_update_tool_cmd: (a) => {
    const t = toolboxTools.find((x) => x.id === a.id);
    if (t) {
      if (a.label != null) t.label = a.label;
      if (a.category != null) t.category = a.category;
      if (a.source != null) t.source = a.source;
      if (a.notes != null) t.notes = a.notes;
    }
    return toolboxView();
  },
  toolbox_remove_tool_cmd: (a) => {
    toolboxTools = toolboxTools.filter((t) => t.id !== a.id);
    return toolboxView();
  },
  toolbox_move_tool_cmd: (a) => {
    const i = toolboxTools.findIndex((t) => t.id === a.id);
    const j = a.direction === "up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < toolboxTools.length) {
      [toolboxTools[i], toolboxTools[j]] = [toolboxTools[j], toolboxTools[i]];
    }
    return toolboxView();
  },
  toolbox_fetch_tool_cmd: async (a) => {
    await delay(900);
    const t = toolboxTools.find((x) => x.id === a.id);
    if (t && t.kind === "url") {
      t.resolvedPath = `${HOME}\\AppData\\Roaming\\TDXLU\\tox_cache\\${t.label}.tox`;
    }
    return toolboxView();
  },
  toolbox_add_category_cmd: (a) => {
    if (!toolboxCategories.includes(a.name)) toolboxCategories.push(a.name);
    return toolboxView();
  },
  toolbox_rename_category_cmd: (a) => {
    toolboxCategories = toolboxCategories.map((c) => (c === a.old ? a.new : c));
    toolboxTools.forEach((t) => {
      if (t.category === a.old) t.category = a.new;
    });
    return toolboxView();
  },
  toolbox_remove_category_cmd: (a) => {
    toolboxCategories = toolboxCategories.filter((c) => c !== a.name);
    toolboxTools.forEach((t) => {
      if (t.category === a.name) t.category = "";
    });
    return toolboxView();
  },
  toolbox_move_category_cmd: (a) => {
    const i = toolboxCategories.indexOf(a.name);
    const j = a.direction === "up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < toolboxCategories.length) {
      [toolboxCategories[i], toolboxCategories[j]] = [toolboxCategories[j], toolboxCategories[i]];
    }
    return toolboxView();
  },
  pick_toe_files: () => [],
  pick_tox_files: () => [],
  pick_folder: () => null,
  cache_tox_from_url_cmd: async (a) => {
    await delay(1000);
    const src = String(a.source);
    const filename = (src.replace(/[#?].*$/, "").replace(/\\/g, "/").split("/").pop() || "Component") + (src.endsWith(".tox") ? "" : ".tox");
    return {
      path: `${HOME}\\AppData\\Roaming\\TDXLU\\tox_cache\\${filename}`,
      source: src,
      filename,
      fromCache: false,
      resolvedUrl: src.includes("/") && !src.startsWith("http") ? `https://github.com/${src}/releases/latest` : src,
    };
  },

  /* python packages */
  tdp_env_status_cmd: (a) => {
    const p = byPath(a.path);
    const ready = p?.name === "AuroraSet";
    return {
      projectDir: p?.dir ?? "",
      hasContext: ready,
      contextSource: ready ? ".venv" : null,
      venvPath: ready ? `${p!.dir}\\.venv` : null,
      pythonPath: ready ? `${p!.dir}\\.venv\\Scripts\\python.exe` : null,
      uvPath: `${HOME}\\.local\\bin\\uv.exe`,
      uvAvailable: true,
      ready,
    };
  },
  tdp_install_package_cmd: async (a) => {
    await delay(1400);
    const name = String(a.spec).split(/[=<>@ ]/)[0];
    return {
      spec: a.spec,
      module: name.replace(/-/g, "_"),
      toxPath: `${PROJ}\\AuroraSet\\.venv\\Lib\\site-packages\\${name.replace(/-/g, "_")}\\${name}.tox`,
      venvPath: `${PROJ}\\AuroraSet\\.venv`,
      alreadyInstalled: false,
      uvLog: `Resolved 3 packages in 0.9s\nInstalled ${name} + 2 dependencies`,
    };
  },
  tdp_pypi_catalog_cmd: () => ({
    source: "https://pypi.org",
    fetchedAt: Date.now(),
    packages: tdpPackages.map((p) => ({ ...p })),
    fromCache: false,
  }),
  tdp_pypi_readme_cmd: (a) => ({
    name: a.name,
    markdown: `# ${a.name}\n\nDemo readme — in the real app this is the package's PyPI readme.\n\n\`\`\`\nuv pip install ${a.name}\n\`\`\``,
    sourceUrl: `https://pypi.org/project/${a.name}/`,
  }),

  /* patreon */
  patreon_open_login: () => undefined,
  patreon_try_capture: () => "demo-session-cookie",
  patreon_logout: () => {
    config.patreon_session_cookie = "";
    return { ...config };
  },
  patreon_list_campaigns_cmd: async () => {
    await delay(500);
    return campaigns.map((c) => ({ ...c }));
  },
  patreon_add_creator_cmd: async (a) => {
    await delay(400);
    const url = String(a.url ?? "").trim();
    const slug = url.replace(/\/+$/, "").split("/").pop() || "creator";
    if (!slug) throw new Error("Paste a Patreon creator URL.");
    const added = {
      id: `c-${slug.toLowerCase()}`,
      name: slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
      url: url.startsWith("http") ? url : `https://patreon.com/${slug}`,
      avatarUrl: avatarArt(slug),
      isOwn: false,
      manual: true,
    };
    if (!campaigns.some((c) => c.id === added.id)) campaigns.push(added);
    return added;
  },
  patreon_remove_creator_cmd: async (a) => {
    await delay(150);
    const i = campaigns.findIndex((c) => c.id === a.campaignId);
    if (i >= 0) campaigns.splice(i, 1);
    return undefined;
  },
  patreon_list_tox_posts_cmd: async (a) => {
    await delay(600);
    return (patreonPosts[a.campaignId] ?? []).map((p) => ({ ...(p as object) }));
  },
  patreon_campaign_last_upload_cmd: (a) => {
    const posts = patreonPosts[a.campaignId] ?? [];
    return posts.length ? (posts[0] as { publishedAt: string }).publishedAt : null;
  },
  patreon_campaign_latest_post_cmd: (a) => handlers.patreon_campaign_last_upload_cmd(a),
  patreon_post_detail_cmd: (a) => {
    for (const posts of Object.values(patreonPosts)) {
      const p = posts.find((x) => (x as { id: string }).id === a.postId) as Record<string, unknown> | undefined;
      if (p) {
        return {
          contentHtml: p.contentHtml,
          teaser: p.teaser,
          embedHtml: null,
          embedUrl: null,
          embedProvider: null,
          imageUrl: p.imageUrl,
          canView: p.canView,
          contentIsRich: p.contentIsRich ?? false,
          isVideo: false,
          debug: null,
        };
      }
    }
    return { contentHtml: null, teaser: null, embedHtml: null, embedUrl: null, embedProvider: null, imageUrl: null, canView: false, contentIsRich: false, isVideo: false, debug: null };
  },
  patreon_download_tox_cmd: async (a) => {
    await delay(1200);
    return `${HOME}\\Documents\\TDXLU\\Patreon Downloads\\${a.campaignName}\\${a.filename}`;
  },
  patreon_extract_zip_cmd: async (a) => {
    await delay(1500);
    const dir = `${HOME}\\Documents\\TDXLU\\Patreon Downloads\\${a.campaignName}\\FunctionStore_tools`;
    return {
      zipPath: `${dir}.zip`,
      extractedDir: dir,
      files: [
        { name: "FunctionStore_tools.tox", path: `${dir}\\FunctionStore_tools.tox`, kind: "tox" },
        { name: "RampMatte.tox", path: `${dir}\\extras\\RampMatte.tox`, kind: "tox" },
        { name: "FeedbackScope.tox", path: `${dir}\\extras\\FeedbackScope.tox`, kind: "tox" },
      ],
      fromCache: false,
    };
  },
  patreon_zip_extract_status_cmd: () => null,
  // Nothing is pre-downloaded in the demo — the first drag "downloads".
  patreon_tox_local_path_cmd: () => null,

  /* git */
  git_tool_info_cmd: () => ({
    available: true,
    path: "C:\\Program Files\\Git\\cmd\\git.exe",
    version: "git version 2.47.0.windows.1",
    credential_helper: "manager",
    note: "",
  }),
  git_status_cmd: (a) => gitStatusFor(byPath(a.path)?.dir ?? a.path.replace(/\\[^\\]+$/, "")),
  git_init_cmd: (a) => {
    const dir = byPath(a.path)?.dir ?? a.path.replace(/\\[^\\]+$/, "");
    if (!gitStates.get(dir)?.is_repo) {
      const changes = [
        { path: (a.path.replace(/\\/g, "/").split("/").pop() || "project.toe"), index_status: "?", worktree_status: "?", staged: false, unstaged: false, untracked: true, old_path: null, bytes: byPath(a.path)?.bytes ?? 1000 },
      ];
      // The real init seeds a TouchDesigner .gitignore unless opted out.
      if (a.gitignore !== false) {
        changes.push({ path: ".gitignore", index_status: "?", worktree_status: "?", staged: false, unstaged: false, untracked: true, old_path: null, bytes: 1_180 });
      }
      gitStates.set(dir, {
        is_repo: true,
        branch: "main",
        branches: ["main"],
        ahead: 0,
        changes,
        log: [],
      });
    }
    return gitStatusFor(dir);
  },
  git_stage_cmd: (a) => {
    const dir = byPath(a.path)?.dir ?? a.path;
    const st = gitStates.get(dir);
    if (st) {
      const target = (a.paths as string[]) ?? [];
      st.changes.forEach((c) => {
        if (!target.length || target.includes(c.path)) {
          c.staged = true;
          c.unstaged = false;
          c.untracked = false;
          c.index_status = c.index_status === "?" ? "A" : "M";
          c.worktree_status = " ";
        }
      });
    }
    return gitStatusFor(dir);
  },
  git_unstage_cmd: (a) => {
    const dir = byPath(a.path)?.dir ?? a.path;
    const st = gitStates.get(dir);
    if (st) {
      const target = (a.paths as string[]) ?? [];
      st.changes.forEach((c) => {
        if (!target.length || target.includes(c.path)) {
          if (c.index_status === "A") {
            c.untracked = true;
            c.index_status = "?";
            c.worktree_status = "?";
          } else {
            c.unstaged = true;
            c.index_status = " ";
            c.worktree_status = "M";
          }
          c.staged = false;
        }
      });
    }
    return gitStatusFor(dir);
  },
  git_ignore_add_cmd: () => true,
  git_commit_cmd: (a) => {
    const dir = byPath(a.path)?.dir ?? a.path;
    const st = gitStates.get(dir);
    if (st) {
      if (a.addAll) st.changes = [];
      else st.changes = st.changes.filter((c) => !c.staged);
      st.ahead += 1;
      st.log = [
        { ...mkCommit(50 + st.log.length, 0, a.message.split("\n")[0]), relative_time: "just now", timestamp: now() },
        ...st.log,
      ];
    }
    return gitStatusFor(dir);
  },
  git_checkout_cmd: (a) => {
    const dir = byPath(a.path)?.dir ?? a.path;
    const st = gitStates.get(dir);
    if (st) {
      st.branch = a.branch;
      if (a.create && !st.branches.includes(a.branch)) st.branches.push(a.branch);
    }
    return gitStatusFor(dir);
  },
  git_set_remote_cmd: (a) => gitStatusFor(byPath(a.path)?.dir ?? a.path),
  git_diff_cmd: (a) => ({
    path: a.file,
    staged: a.staged ?? false,
    binary: /\.(toe|tox|png|jpg|mov|mp4|wav)$/i.test(a.file),
    text: /\.(toe|tox|png|jpg|mov|mp4|wav)$/i.test(a.file) ? "" : README_DIFF,
  }),
  git_log_cmd: (a) => {
    const st = gitStates.get(byPath(a.path)?.dir ?? a.path);
    return (st?.log ?? []).map((c) => ({ ...c }));
  },
  git_show_cmd: (a) => {
    const st = gitStates.get(byPath(a.path)?.dir ?? a.path);
    const commit = st?.log.find((c) => c.hash === a.rev || c.short_hash === a.rev) ?? st?.log[0] ?? mkCommit(1, 1, "Initial commit");
    return {
      commit: { ...commit },
      body: "",
      parents: [],
      files: [
        { path: "AuroraSet.toe", status: "M" },
        { path: "README.md", status: "M" },
      ],
      diff: { path: a.file ?? "README.md", staged: false, binary: false, text: README_DIFF },
    };
  },
  git_push_cmd: async (a) => {
    await delay(1100);
    const dir = byPath(a.path)?.dir ?? a.path;
    const st = gitStates.get(dir);
    if (st) st.ahead = 0;
    return gitStatusFor(dir);
  },
  git_pull_cmd: async (a) => {
    await delay(900);
    return gitStatusFor(byPath(a.path)?.dir ?? a.path);
  },
  verify_github_token_cmd: async () => {
    await delay(500);
    return { login: "nordlys-demo", name: "Dan Molnar", avatar_url: avatarArt("Dan Molnar") };
  },

  /* backup */
  backup_target_info_cmd: (a) => {
    const p = byPath(a.path);
    return {
      local_root: p?.dir ?? "",
      remote_root: `${a.remoteOverride ?? config.backup_root}\\${p?.name ?? "Project"}`,
      remote_exists: p?.name === "AuroraSet",
      local_file_count: 214,
      remote_file_count: p?.name === "AuroraSet" ? 209 : 0,
      local_filtered: 12,
      remote_filtered: 0,
      git_repo: gitStates.get(p?.dir ?? "")?.is_repo ?? false,
    };
  },
  backup_plan_cmd: async (a) => {
    await delay(800);
    const p = byPath(a.path);
    const ops = [
      { relative: `${p?.name ?? "Project"}.toe`, direction: "to_remote", reason: "newer", bytes: p?.bytes ?? 1_000_000 },
      { relative: "preview\\preview.png", direction: "to_remote", reason: "new", bytes: 412_000 },
      { relative: "media\\intro.mp4", direction: "to_remote", reason: "newer", bytes: 264_000_000 },
    ];
    return {
      local_root: p?.dir ?? "",
      remote_root: `${a.remoteOverride ?? config.backup_root}\\${p?.name ?? "Project"}`,
      mode: a.mode,
      ops,
      to_remote: a.mode === "restore" ? 0 : ops.length,
      to_local: a.mode === "restore" ? ops.length : 0,
      skipped: 206,
      filtered: 12,
      summary: `${ops.length} files → ${a.mode === "restore" ? "project" : "backup"} (312 MB)`,
      gitignore_active: (config.backup_respect_gitignore as boolean) && (gitStates.get(p?.dir ?? "")?.is_repo ?? false),
    };
  },
  backup_run_cmd: async (a) => {
    await delay(1800);
    const p = byPath(a.path);
    return {
      local_root: p?.dir ?? "",
      remote_root: `${a.remoteOverride ?? config.backup_root}\\${p?.name ?? "Project"}`,
      mode: a.mode,
      copied_to_remote: a.mode === "restore" ? 0 : 3,
      copied_to_local: a.mode === "restore" ? 3 : 0,
      skipped: 206,
      filtered: 12,
      bytes_copied: 312_800_000,
      errors: [],
      summary: "Copied 3 files (312 MB) in 1.8s",
    };
  },
  rclone_status_cmd: () => ({ ...rclone, remotes: rclone.remotes.map((r) => ({ ...r })) }),
  rclone_install_cmd: async () => {
    await delay(1500);
    rclone = { ...rclone, available: true, version: "1.68.2", path: `${HOME}\\AppData\\Roaming\\TDXLU\\rclone\\rclone.exe` };
    return handlers.rclone_status_cmd({});
  },
  rclone_remote_add_cmd: async (a) => {
    await delay(1200);
    rclone.remotes.push({ name: a.name, provider: a.provider });
    return handlers.rclone_status_cmd({});
  },
  rclone_remote_delete_cmd: (a) => {
    rclone.remotes = rclone.remotes.filter((r) => r.name !== a.name);
    return handlers.rclone_status_cmd({});
  },
  cloud_backup_info_cmd: (a) => handlers.backup_target_info_cmd({ path: a.path, remoteOverride: `${a.remote}:` }),
  cloud_backup_plan_cmd: (a) => handlers.backup_plan_cmd({ path: a.path, mode: a.mode, remoteOverride: `${a.remote}:` }),
  cloud_backup_run_cmd: (a) => handlers.backup_run_cmd({ path: a.path, mode: a.mode, remoteOverride: `${a.remote}:` }),

  /* watchdog */
  watch_status_cmd: () => watchOverview(),
  watch_project_id_cmd: (a) => watchId(a.path),
  watch_start_cmd: (a) => {
    const id = watchId(a.path);
    if (!watchSessions.some((s) => s.id === id)) {
      const name = a.path.replace(/\\/g, "/").split("/").pop() ?? a.path;
      watchSessions.push({
        id,
        active: true,
        phase: "watching",
        project_path: a.path,
        version_key: a.versionKey,
        use_touchplayer: a.useTouchplayer ?? false,
        pid: a.existingPid ?? sessions.find((s) => s.path === a.path)?.pid ?? null,
        last_heartbeat_secs_ago: 2,
        fps: 60,
        crash_count: 0,
        message: "Heartbeat OK",
        log_lines: [
          `[${new Date().toLocaleTimeString()}] watch started for ${name}`,
          `[${new Date().toLocaleTimeString()}] heartbeat OK (60 fps)`,
        ],
      });
    }
    const ov = watchOverview();
    emitMock("watch-status", ov);
    return ov;
  },
  watch_stop_cmd: (a) => {
    watchSessions = watchSessions.filter((s) => s.id !== a.id);
    const ov = watchOverview();
    emitMock("watch-status", ov);
    return ov;
  },
  watch_stop_all_cmd: () => {
    watchSessions = [];
    const ov = watchOverview();
    emitMock("watch-status", ov);
    return ov;
  },

  /* MCP / Envoy */
  mcp_status_cmd: (a) => {
    const p = byPath(a.path);
    if (p?.name === "AuroraSet") {
      return {
        provider_id: "envoy",
        provider_label: "Envoy",
        detected: true,
        project_root: p.dir,
        envoy_json: `${p.dir}\\envoy.json`,
        mcp_json: `${p.dir}\\.mcp.json`,
        active_instance: "AuroraSet",
        port: 9870,
        toe_path: p.path,
        td_executable: INSTALLED[1].executable,
        td_pid: 18244,
        td_alive: true,
        port_open: true,
        envoy_reachable: true,
        mcp_server_keys: ["envoy"],
        mcp_snippet: JSON.stringify({ mcpServers: { envoy: { type: "http", url: "http://localhost:9870/mcp" } } }, null, 2),
        bridge_command: null,
        status: "online",
        message: "Envoy MCP reachable on 127.0.0.1:9870",
      };
    }
    return {
      provider_id: null,
      provider_label: null,
      detected: false,
      project_root: p?.dir ?? null,
      envoy_json: null,
      mcp_json: null,
      active_instance: null,
      port: null,
      toe_path: p?.path ?? null,
      td_executable: null,
      td_pid: null,
      td_alive: false,
      port_open: false,
      envoy_reachable: false,
      mcp_server_keys: [],
      mcp_snippet: null,
      bridge_command: null,
      status: "not_detected",
      message: "No .mcp.json found next to this project.",
    };
  },
  mcp_open_folder_cmd: () => undefined,
  mcp_set_port_cmd: (a) => handlers.mcp_status_cmd(a),
};

/** Entry point wired into the @tauri-apps/api/core shim. */
export async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const h = handlers[cmd];
  if (!h) {
    console.warn(`[demo] unmocked command: ${cmd}`, args);
    return null;
  }
  return h(args ?? {});
}

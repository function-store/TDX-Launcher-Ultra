// -- Tour philosophy ----------------------------------------------------------
// One pass over the shape of the app: the tour drives the UI as it talks —
// each step names the tab it belongs on, and the overlay switches there during
// the card's fade so the spotlight lands on live content, not a mental model.
// Cards stay short; the Help modal and the first-encounter hints (src/hints)
// carry the deep detail.
// Targets are `data-tour` attributes in App.tsx, not style classes, so visual
// refactors don't silently break the spotlight.

import type { TabId } from "../types";

export interface TourStep {
  id: string;
  /** CSS selector for the element to spotlight. null = centered card (intro/outro). */
  target: string | null;
  placement: "top" | "bottom" | "left" | "right" | "center" | "auto";
  title: string;
  /** Inline HTML (authored here, rendered via dangerouslySetInnerHTML). */
  body: string;
  /** Tab to switch to before this step is shown. Omitted = stay where we are. */
  tab?: TabId;
  /** Extra px padding around the spotlight cutout. */
  spotlightPad?: number;
  /** Render the color-theme picker inline in the card. */
  showThemePicker?: boolean;
  /** Close with the ask to support Function Store (the tour's last card). */
  showSupport?: boolean;
  isLast?: boolean;
}

/** Label for the little tab chip on the card — reads as "we're on Templates now". */
export const TAB_LABELS: Record<TabId, string> = {
  recent: "Recent Files",
  current: "Sessions",
  templates: "Templates",
  palette: "Palette",
  fns: "FNSTools",
  patreon: "Patreon",
};

export function buildTourSteps(ctx: {
  patreonEnabled: boolean;
  /** The FNSTools tab is on screen (Settings → General → Show the FNSTools tab). */
  fnsTabShown: boolean;
  mod: string;
  isMac: boolean;
  /** Configured Quick Launch hotkey (accelerator string), for the quick-launch card. */
  hotkey?: string;
  /** Configured main-window hotkey (accelerator string), for the hotkey cards. */
  hotkeyMain?: string;
  /** True when the setup wizard hasn't run yet — it opens right after the tour. */
  wizardFollows: boolean;
  /**
   * The companion TOX is a bundled resource, so this is true in every shipped
   * installer — and then it is ALREADY in the user's palette and toolbox
   * (auto-installed on first run). Only an unbundled dev build gets the
   * download pointer.
   */
  bundledUtility: boolean;
  /** At least one pane will be showing stand-in rows — say so, don't fake it silently. */
  usesDemoData: boolean;
}): TourStep[] {
  const { patreonEnabled, fnsTabShown, mod, isMac, wizardFollows, bundledUtility, usesDemoData } =
    ctx;
  // The tab bar, in bar order. Alt shortcuts follow keybindings.ts defaults:
  // Patreon keeps Alt+5 and FNSTools has Alt+6, though FNSTools sits first.
  const alt = isMac ? "⌥" : "Alt+";
  const tabCount = 4 + (fnsTabShown ? 1 : 0) + (patreonEnabled ? 1 : 0);
  const countWord = ["Four", "Five", "Six"][tabCount - 4];
  const hotkeyLabel = (ctx.hotkey || "Alt+Shift+D").replace(
    /CommandOrControl|CmdOrCtrl/i,
    mod,
  );
  const hotkeyMainLabel = (ctx.hotkeyMain || "CommandOrControl+Shift+D").replace(
    /CommandOrControl|CmdOrCtrl/i,
    mod,
  );
  const steps: TourStep[] = [
    {
      id: "welcome",
      target: null,
      placement: "center",
      title: "Welcome to TDX Launcher Ultra",
      body:
        "A dashboard for your TouchDesigner projects: launch every <b>.toe</b> with the right build, watch running sessions, and manage templates, palette components, git and backups.\n\nThe tour drives the app as it goes — tabs switch under you. Two minutes; <b>Esc</b> skips, arrow keys navigate." +
        (usesDemoData
          ? "\n\n<i>Nothing's in your lists yet, so panels that would be empty show sample projects. They vanish when the tour ends.</i>"
          : "") +
        "\n\nFirst, pick a look:",
      tab: "recent",
      showThemePicker: true,
    },
    {
      id: "tabs",
      target: '[data-tour="tabs"]',
      placement: "bottom",
      title: `${countWord} tabs, ${countWord.toLowerCase()} jobs`,
      body:
        "<b>Recent Files</b> — everything you've opened, with TouchDesigner's own history merged in.\n<b>Sessions</b> — TD sessions running right now.\n<b>Templates</b> — starter .toe files with quick-launch shortcuts.\n<b>Palette</b> — .tox components, ready to drag into TD." +
        (fnsTabShown
          ? "\n<b>FNSTools</b> — the FNSTools catalog: install tools into a project, edit their settings."
          : "") +
        (patreonEnabled
          ? "\n<b>Patreon</b> — import .tox components from creators you support."
          : "") +
        // NOT `${mod}+1…5` — that launches template slots 1–5 (see the Templates card).
        `\n\n<b>Tab</b> / <b>Shift+Tab</b> cycle them, or <b>${alt}1…4</b>` +
        (patreonEnabled ? `, <b>${alt}5</b> Patreon` : "") +
        (fnsTabShown ? `, <b>${alt}6</b> FNSTools` : "") +
        "." +
        (fnsTabShown
          ? "\n\nWe'll visit each one but FNSTools, which gets a tip the first time you open it."
          : "\n\nWe'll visit each one."),
      tab: "recent",
    },

    // -- Recent Files -------------------------------------------------------
    {
      id: "files",
      target: '[data-tour="files"]',
      placement: "auto",
      title: "Your projects",
      body:
        "Click to select, <b>double-click to launch</b>. Gallery tiles show each project's icon or hero image — tiles with a preview clip play it on hover.\n\nA <b>⑂</b> badge means the project has version copies — <b>Name.2.toe</b> increments, <b>Backup/</b> saves, crash autosaves — folded into one card. Click it for the versions drawer: launch any copy, restore one as the head, or prune old ones to the recycle bin.\n\nTags show on tiles, and drop a <b>.toe</b> anywhere on the window to add it. Prefer rows? Switch to List view in the toolbar.",
      tab: "recent",
      spotlightPad: 4,
    },
    {
      id: "versions",
      target: '[data-tour="versions"]',
      placement: "top",
      title: "Version detection",
      body:
        "Selecting a project reads which TD build it needs and highlights the matching install — pick another to override, or check <b>Use TouchPlayer</b>.\n\nIf the build isn't installed, a <b>Download</b> button fetches the exact installer from Derivative. Project media (stills and clips from a <b>preview/</b> folder) shows here too.",
      tab: "recent",
      spotlightPad: 4,
    },
    {
      id: "launch",
      target: '[data-tour="launch"]',
      placement: "top",
      title: "Launch",
      body:
        "Launches the selected file with the chosen version — <b>Enter</b> works too.\n\nDouble-clicking a .toe in your file manager opens the launcher with a 5-second auto-launch countdown; any click cancels it.",
      tab: "recent",
      spotlightPad: 4,
    },
    {
      id: "toolbar",
      target: '[data-tour="toolbar"]',
      placement: "bottom",
      title: "Toolbar",
      body:
        `<b>Search</b> filters the list (${mod}+F, with <b>*</b> and <b>?</b> wildcards). <b>Browse…</b> adds projects — on Templates and Palette it adds templates or folders instead.\n\nSwitch <b>Gallery / List</b> here; icons, version collapsing and theme live in the <b>View</b> menu up top.`,
      tab: "recent",
    },
    {
      id: "tools",
      target: '[data-tour="tools"]',
      placement: "left",
      title: "Inspector dock",
      body:
        "The compact right-edge dock is the home for project inspectors:\n\n<b>Info</b> — README viewer and editor.\n<b>Git</b> — changes, diffs, commit, push, history.\n<b>Backup</b> — sync the project folder to USB or cloud-drive folders.\n<b>Heartbeat</b> — crash watchdog with auto-relaunch and email alerts.\n<b>Envoy</b> appears when the project has Embody/Envoy (<b>.mcp.json</b>).\n\nLeft-click opens one panel. <b>Ctrl/Cmd-click</b>, or right-click → <b>Open alongside</b>, stacks up to three. Sessions also adds <b>Control</b> and <b>Media files</b>. Tags live beside Search because they filter the list. Use <b>View → Show panel labels</b> when you want names under the icons.",
      tab: "recent",
      spotlightPad: 4,
    },

    // -- Sessions -----------------------------------------------------------
    {
      id: "current",
      target: '[data-tour="files"]',
      placement: "auto",
      title: "Live sessions",
      body:
        "Here we are on <b>Sessions</b> — every running TD session, including ones opened outside the launcher, gets its own card. Nothing is hidden in a separate detail pane.\n\nEach card shows its thumbnail, version, PID, Envoy, uptime and performance at a glance. The split camera/video control updates the thumbnail or records the hover preview; the rest of the action model is shared with Quick Launch and the phone page. Expand a card for its windows and tool capabilities.",
      tab: "current",
      spotlightPad: 4,
    },
    {
      id: "companion",
      target: null,
      placement: "center",
      title: "The companion TOX",
      body:
        "The launcher can only <i>start</i> TouchDesigner. <b>TDXLauncherUtility.tox</b> is what lets it talk to a session that's already running, and it unlocks the card's session controls:\n\n<b>Thumbnail / Preview video</b> — capture the project icon, still and hover preview clip into <b>preview/</b>.\n<b>Save</b> — save the .toe in place.\n<b>Tool capabilities</b> — collect &amp; save, the media browser, autosave and a phone remote arrive as rows inside the expanded card from the FNSTools packages that provide them.\n<b>Add to project ▾</b> — place components into the live network from disk, GitHub, any URL, or PyPI.\n<b>Heartbeat</b> — the crash watchdog listens for companion pulses." +
        (isMac ? "\n<b>Recents sync</b> — on macOS it also feeds TouchDesigner's recent files into this list." : ""),
      tab: "current",
    },
    {
      id: "companion-install",
      target: null,
      placement: "center",
      title: bundledUtility ? "It's already here — just drag it in" : "Getting the companion TOX",
      body: bundledUtility
        ? "It ships inside this app. On first run it was copied into your <b>Palette</b> and pinned in the <b>Toolbox</b> as <b>Launcher Utility</b> — nothing to download, nothing to install.\n\nIf a session has no companion, expand its card: the notice offers a <b>⠿ TDXLauncherUtility.tox</b> handle — <b>drag that straight into the project's root network</b> in TouchDesigner, then save. That's the whole thing.\n\nThe same drag works from the <b>Palette</b> tab and the <b>Toolbox</b>.\n\nEvery existing <b>.toe</b> needs that drag once. To stop repeating it, put the TOX in TouchDesigner's <b>startup file</b> — then anything you build from scratch has it from the first save. The card notice spells out how."
        : "This build doesn't carry the bundled TOX, so grab it from <b>Help → Download Utility TOX</b> and drop it into a project's root network (or your TD startup file).\n\nShipped installers include it and put it in your Palette automatically.",
      tab: "current",
    },

    // -- Templates ----------------------------------------------------------
    {
      id: "templates",
      target: '[data-tour="files"]',
      placement: "auto",
      title: "Templates",
      body:
        `Now the <b>Templates</b> tab — starter .toe files you begin projects from.\n\nThey keep their own order (<b>${mod}+↑ / ↓</b> to reorder) and each position gets a shortcut: <b>${mod}+1…9</b> launches that template from anywhere in the app. <b>${mod}+D</b> starts TD on its default startup file.\n\n<b>Add Templates…</b> in the toolbar puts a .toe here.`,
      tab: "templates",
      spotlightPad: 4,
    },
    {
      id: "template-version",
      target: '[data-tour="template-version"]',
      placement: "bottom",
      title: "One build for the whole tab",
      body:
        "Templates are usually build-agnostic, so instead of picking a version per file, the tab has one default. <b>Latest</b> follows your newest non-branched install as you update TD.",
      tab: "templates",
      spotlightPad: 6,
    },

    // -- Palette ------------------------------------------------------------
    {
      id: "palette",
      target: '[data-tour="files"]',
      placement: "auto",
      title: "Palette",
      body:
        "The <b>Palette</b> tab is your <b>.tox</b> library: TouchDesigner's factory palette for the selected build, your <b>Documents/Derivative/Palette</b>, plus any folders you add.\n\n<b>Drag a component straight from here into a TD network</b> — or use the <b>↳</b> hover action to send it into a running session.",
      tab: "palette",
      spotlightPad: 4,
    },
    {
      id: "toolbox",
      target: '[data-tour="toolbox"]',
      placement: "auto",
      title: "Toolbox — your favourites shelf",
      body:
        "Pinned at the top of the palette: the components you reach for on every project, in categories you name.\n\nPin by dropping a <b>.tox</b> on it, or with <b>＋ Tool</b>. A tool can be a file on disk, a <b>GitHub repo / URL</b> (re-fetch with ⟳ to pull the latest release), or a package spec.\n\nThe bundled companion TOX is already pinned there.",
      tab: "palette",
      spotlightPad: 6,
    },
    {
      id: "palette-place",
      target: '[data-tour="palette-place"]',
      placement: "top",
      title: "Send it into a running session",
      body:
        "Pick a component above, choose the session, hit <b>Load</b> — it lands in that project's network editor. Needs the companion TOX running in the session.",
      tab: "palette",
      spotlightPad: 6,
    },
  ];

  if (patreonEnabled) {
    steps.push({
      id: "patreon",
      target: '[data-tour="files"]',
      placement: "auto",
      title: "Patreon import",
      body:
        "Browse <b>.tox</b> components from creators you support and load one straight into a running session — the same path as “From URL…”.\n\nConnect it in <b>Settings → Patreon</b> first. It is <b>unofficial</b> — your own Patreon login against their private web API, showing only what your account can already see.\n\nAnd a component is a program: placing one runs its creator's code on this machine, so stick to creators you trust.",
      tab: "patreon",
      spotlightPad: 4,
    });
  }

  steps.push(
    {
      id: "quick",
      target: null,
      placement: "center",
      title: "Always a keystroke away",
      body:
        `One more thing, and it works from anywhere — TD fullscreen included. Press <b>${hotkeyMainLabel}</b> and this window comes up over whatever you're doing.\n\nFor the times you'd rather type than browse, a second hotkey — <b>${hotkeyLabel}</b> — opens <b>Quick Launch</b>, a small search box over everything. Type a few letters: <b>projects launch</b> with the right build, <b>running sessions focus</b>, <b>components place</b> into the live session — or drag the row straight into a TD network.\n\n<b>&gt;</b> shows commands: <b>&gt;ki</b> ↵ ↵ kills a session (destructive commands always ask for a second Enter). <b>/folder</b> browses a palette folder, Toolbox category or your Patreon cache; <b>#tag</b> filters by project tag.\n\nBoth combos — and a third that jumps straight to the Palette tab — live in <b>Settings</b>.`,
      tab: "recent",
    },
  );

  steps.push({
    id: "phone",
    target: '[data-tour="phone"]',
    placement: "bottom",
    title: "Run the show from your phone",
    body:
      "One tap turns on LAN access and shows a <b>QR</b> — scan it and a touch remote opens on your phone (same Wi-Fi). Every session is a tab: save, update its thumbnail, record a preview video, relaunch or kill it (destructive taps are <b>hold-to-confirm</b>), watch a live perf readout, launch recent projects, and work the exposed <b>control parameters</b> — with page tabs, pins and nudge steppers.\n\nHanding the phone to someone else? The pairing dialog's <b>Client link</b> is a separate code that opens <i>only the controls you exposed</i> — no session actions, no browsing. The server enforces it, not just the page.\n\nAdd it to the phone's home screen once; the pairing survives restarts.",
    tab: "recent",
    spotlightPad: 4,
  });

  steps.push(
    {
      id: "header",
      target: '[data-tour="header-actions"]',
      placement: "bottom",
      title: "View, Settings & Help",
      body:
        "<b>View</b> — layout, icons, version collapsing, panel-rail density and theme.\n<b>Settings</b> — tray behavior, global hotkeys, GitHub token, backup filters, alert email, and settings export/import.\n<b>Help</b> — shortcuts, this tour, the setup wizard, and About & updates.",
      tab: "recent",
    },
    {
      id: "outro",
      target: null,
      placement: "center",
      title: wizardFollows ? "That's the tour" : "You're ready",
      body: wizardFollows
        ? "Next up: a quick <b>setup wizard</b> — pick your look, set the <b>.toe</b> file association, choose tray & hotkey behavior, and set up backups, GitHub or Patreon if you want them.\n\nAs you go, short tips pop up the first time you open a panel or a tab. Replay this tour anytime from <b>Help</b>."
        : "That's the tour — pick a project and launch.\n\nShort tips will pop up the first time you open a panel or a tab; <b>Help → “Show them again”</b> re-arms them.",
      tab: "recent",
      isLast: true,
      showThemePicker: !wizardFollows,
      showSupport: true,
    },
  );

  return steps;
}

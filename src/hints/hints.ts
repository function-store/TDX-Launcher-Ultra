// -- First-encounter hints ("coach marks") ------------------------------------
// The tour narrates the shape of the app; these fill in the detail you only
// care about at the moment you first open a thing. One hint per surface, shown
// once ever, dismissed by clicking anywhere. Anchors are `data-hint` attributes
// so restyling never orphans a hint.
//
// Rule for the copy: say something the tour did NOT. If a hint only repeats a
// tour card it's noise — delete it instead.

export type HintId =
  | "tab-current"
  | "tab-templates"
  | "tab-palette"
  | "tab-patreon"
  | "tab-fns"
  | "tool-info"
  | "tool-tags"
  | "tool-git"
  | "tool-backup"
  | "tool-watch"
  | "tool-mcp"
  | "companion-missing"
  | "search";

export interface HintDef {
  id: HintId;
  /** CSS selector for the element the bubble points at. */
  target: string;
  title: string;
  /** Inline HTML, same convention as the tour cards. */
  body: string;
  /** Preferred side of the anchor. Falls back automatically when it won't fit. */
  placement?: "top" | "bottom" | "left" | "right";
}

export function buildHints(ctx: { mod: string; isMac: boolean }): Record<HintId, HintDef> {
  const { mod } = ctx;
  return {
    "tab-current": {
      id: "tab-current",
      target: '[data-hint="tab-current"]',
      title: "One card per session",
      body: "The version is already decided, so Sessions has no version-detail pane. Every live or ended session gets a card with its own actions; expand it for windows, companion status and tool capability rows.\n\nUptime is only known for sessions this launcher started. The <b>▭ n</b> chip beside Phone searches every open TD window.",
      placement: "bottom",
    },
    "tab-templates": {
      id: "tab-templates",
      target: '[data-hint="tab-templates"]',
      title: "Templates have shortcuts",
      body: `<b>${mod}+1…9</b> launches the template in that position from anywhere in the app, and <b>${mod}+↑ / ↓</b> reorders the list — so the numbers are yours to assign.\n\n<b>${mod}+D</b> starts TouchDesigner on its own default startup file.`,
      placement: "bottom",
    },
    "tab-palette": {
      id: "tab-palette",
      target: '[data-hint="tab-palette"]',
      title: "Drag straight into TouchDesigner",
      body: "Any <b>.tox</b> row can be dragged from here into a TD network. No session open? The <b>↳</b> hover action loads it into a running one instead.\n\nDrop a .tox onto the <b>Toolbox</b> to pin it — onto a category row to file it there.",
      placement: "bottom",
    },
    "tab-patreon": {
      id: "tab-patreon",
      target: '[data-hint="tab-patreon"]',
      title: "Needs your session cookie",
      body: "Patreon's official API can't list post attachments, so this drives their private web API with your own login — <b>Settings → Patreon</b>: log in there, or paste your <b>session_id</b> cookie by hand if your account signs in with Google or Apple.\n\nIt only ever reads what your account can already see, and it stops working when that session expires — log in again and the creators come back.",
      placement: "bottom",
    },
    "tab-fns": {
      id: "tab-fns",
      target: '[data-hint="tab-fns"]',
      title: "FNSTools, à la carte",
      body: "Pick any subset of <b>FNSTools</b> and install it into a running session — the toolkit's own installer does the landing, so settings and updates keep working. <b>Tool settings</b> edits every installed tool's options globally, live or offline.",
      placement: "bottom",
    },
    "tool-info": {
      id: "tool-info",
      target: '[data-hint="tool-info"]',
      title: "Project README, in place",
      body: `The panel reads the selected project's README. <b>${mod}+E</b> switches to editing and <b>${mod}+S</b> saves it — no external editor, and the file stays plain markdown next to the .toe.`,
      placement: "left",
    },
    "tool-tags": {
      id: "tool-tags",
      target: '[data-hint="tool-tags"]',
      title: "Tags nest with a slash",
      body: "A tag like <b>show/live</b> creates a <b>show</b> group with <b>live</b> under it, so you can filter broad or narrow. Tags are stored in the project's sidecar file, not a central database — move the project and they follow.",
      placement: "bottom",
    },
    "tool-git": {
      id: "tool-git",
      target: '[data-hint="tool-git"]',
      title: "Git for the project folder",
      body: "<b>Changes</b> stages and commits with a live diff; <b>History</b> browses the log and shows any commit. Branch, pull and push are here too.\n\nPushing to GitHub wants a token — <b>Settings → GitHub</b>. The panel stays empty until the project folder is a repo.",
      placement: "left",
    },
    "tool-backup": {
      id: "tool-backup",
      target: '[data-hint="tool-backup"]',
      title: "Mirror the folder anywhere",
      body: "Point it at a USB stick or a synced cloud folder, or hit <b>+ cloud</b> to connect Drive / Dropbox / OneDrive / Box directly (one-time download, sign-in in your browser).\n\nExclude globs and a max file size keep caches and renders out. <b>Nothing is ever deleted at the destination.</b>",
      placement: "left",
    },
    "tool-watch": {
      id: "tool-watch",
      target: '[data-hint="tool-watch"]',
      title: "Crash watchdog",
      body: "The project's companion TOX sends a TCP pulse every few seconds. Miss enough of them and the launcher relaunches the project — and emails you, if you set up SMTP in Settings.\n\nSo it needs the companion running inside the project; without it there's no pulse to miss.",
      placement: "left",
    },
    "tool-mcp": {
      id: "tool-mcp",
      target: '[data-hint="tool-mcp"]',
      title: "Embody / Envoy bridge",
      body: "This appears because the project has an <b>.mcp.json</b>. The panel reports the Envoy port and whether it's answering, and can start TD for you when it isn't.\n\nThat's the same bridge an AI coding agent talks to.",
      placement: "left",
    },
    "companion-missing": {
      id: "companion-missing",
      target: '[data-hint="companion-missing"]',
      title: "Drag this into the project",
      body: "This session has no companion, so the launcher can't save it, update its thumbnail, record a preview video, or load components into it.\n\nThe <b>⠿</b> handle is the bundled TOX — <b>drag it into the project's root network</b> in TouchDesigner and save. It already lives in your Palette and Toolbox too.\n\nExisting <b>.toe</b> files each need that drag once; put the TOX in TouchDesigner's <b>startup file</b> and everything you build from scratch has it already. The expanded card walks through it.",
      placement: "top",
    },
    search: {
      id: "search",
      target: '[data-hint="search"]',
      title: "Wildcards work here",
      body: "<b>*</b> matches any run of characters and <b>?</b> exactly one — so <b>show_*_v?</b> narrows fast. <b>↑ / ↓</b> move through the filtered list, <b>Enter</b> keeps the filter and closes the box, <b>Esc</b> clears it.",
      placement: "bottom",
    },
  };
}

/** Demo data for the FNSTools tab: a trimmed but shape-faithful release
 *  manifest, a palette-store state, and a live-settings state — enough for
 *  the store, install and configurator flows to demo end to end. */

export const FNS_DEMO_STORE_DIR = "C:\\Users\\demo\\Documents\\Derivative\\Palette\\FNSTools\\store";
const CONFIG_PATH =
  "C:/Users/demo/Documents/Derivative/Palette/FNSTools/config/FNStools_config.json";

const CORE = [
  "FNS_ConfigRegistry",
  "FNS_MainMenuRegistry",
  "FNS_NavbarRegistry",
  "FNS_OpMenuRegistry",
  "FNS_PaneTypeRegistry",
  "FNS_ToolbarRegistry",
  "FNS_Updater",
];

const CATEGORY_META: Record<string, { glyph: string; pitch: string }> = {
  Core: { glyph: "◈", pitch: "The registries every other tool plugs into. Installed as a unit." },
  Surfaces: { glyph: "▦", pitch: "The parts of TouchDesigner you look at all day, made yours." },
  Parameters: { glyph: "◎", pitch: "Promote, bind, randomize and reset — by drag and drop." },
  Network: { glyph: "⇄", pitch: "Build, swap, collapse and navigate without touching a menu." },
  "Media & Output": { glyph: "▶", pitch: "Where the picture and the sound actually leave the project." },
  Control: { glyph: "⊙", pitch: "Hardware in, parameters out." },
  Workflow: { glyph: "⚡", pitch: "The small frictions, removed." },
  Developer: { glyph: "⌨", pitch: "Extensions, stubs and the editor you actually write them in." },
};

type DemoPkg = {
  name: string;
  kind: string;
  category: string;
  description: string;
  version: string;
};

const PKGS: DemoPkg[] = [
  ...CORE.map((name) => ({
    name,
    kind: "core",
    category: "Core",
    description: "Core registry.",
    version: "2.0.0",
  })),
  { name: "FNS_Toolbar", kind: "tool", category: "Surfaces", description: "A dockable toolbar of one-click tools above the network editor.", version: "1.2.0" },
  { name: "FNS_Navbar", kind: "tool", category: "Surfaces", description: "Breadcrumb navigation bar with parent-hierarchy jumps and drag-drop hijacks.", version: "1.1.3" },
  { name: "FNS_OpMenu", kind: "tool", category: "Surfaces", description: "Extended OP-create menu with search keywords and favorites.", version: "1.4.1" },
  { name: "ColorUI", kind: "tool", category: "Surfaces", description: "Recolor TouchDesigner's UI families from one palette editor.", version: "1.0.2" },
  { name: "CustomParTools", kind: "tool", category: "Parameters", description: "Promote, bind and collapse custom parameters by drag and drop.", version: "2.1.0" },
  { name: "ParRandomizer", kind: "tool", category: "Parameters", description: "Randomize any set of parameters with per-par ranges.", version: "1.0.5" },
  { name: "QuickParCustom", kind: "tool", category: "Parameters", description: "Turn selected parameters into custom pars on a new base.", version: "1.0.1" },
  { name: "SwapOps", kind: "tool", category: "Network", description: "Swap two operators in place, wires and all.", version: "1.0.4" },
  { name: "QuickCollapse", kind: "tool", category: "Network", description: "Collapse a selection into a base with tidy in/out wiring (ctrl+w).", version: "1.1.0" },
  { name: "AltSelect", kind: "tool", category: "Network", description: "Alternative selection helpers for the network editor.", version: "1.0.1" },
  { name: "AutoRes", kind: "tool", category: "Media & Output", description: "Project-wide resolution reference operators can follow.", version: "1.0.4" },
  { name: "OUTPUT", kind: "tool", category: "Media & Output", description: "One resizable output window with global out selection.", version: "1.2.2" },
  { name: "midiMapper", kind: "tool", category: "Control", description: "MIDI-learn any parameter from a toolbar button.", version: "1.3.0" },
  { name: "oscMapper", kind: "tool", category: "Control", description: "OSC-map parameters with address learning.", version: "1.1.1" },
  { name: "QuickTime", kind: "tool", category: "Workflow", description: "Timeline transport and quick time-range controls.", version: "1.0.0" },
  { name: "HydroHomie", kind: "tool", category: "Workflow", description: "Reminds you to drink water. Really.", version: "1.0.0" },
  { name: "VSCodeTools", kind: "tool", category: "Developer", description: "Open DATs and extensions straight in VS Code with stubs.", version: "1.2.1" },
  { name: "OpenExt", kind: "tool", category: "Developer", description: "Jump from any COMP to its extension code.", version: "1.0.3" },
  // Plus rail: access names a tier id from toolkit.tiers (fns-gate.md §4.3).
  { name: "FNS_TimelineTools", kind: "tool", category: "Workflow", description: "Drive the timeline from your media: filmstrip and waveform behind the ruler.", version: "3.0.3", access: "8323905" },
  // Launcher capabilities: complete TD tools that ALSO light up the Current
  // view. Three Base-tier, one free — the real v3.0.13 shape.
  { name: "FNS_Collect", kind: "tool", category: "Workflow", description: "Collect every external file into the project and relink it.", version: "1.0.0", access: "8323905", launcher: { surfaces: ["session", "context-menu"], capabilities: ["fns.collect"], seedable: false } },
  { name: "FNS_MediaBrowser", kind: "tool", category: "Media & Output", description: "Every media reference in the project, with previews and replace.", version: "1.0.0", access: "8323905", launcher: { surfaces: ["session", "context-menu"], capabilities: ["fns.media-browser"], seedable: false } },
  { name: "FNS_Remote", kind: "tool", category: "Control", description: "Serve this session to a phone: touch, parameters, save.", version: "1.0.0", access: "8323905", launcher: { surfaces: ["session", "context-menu"], capabilities: ["fns.mobile-control"], seedable: false } },
  { name: "FNS_Autosave", kind: "tool", category: "Workflow", description: "Save the project on a timer, from inside TouchDesigner.", version: "1.0.0", access: "free", launcher: { surfaces: ["session", "context-menu"], capabilities: ["fns.autosave"], seedable: true } },
];

const sha = (n: string) => n.padEnd(8, "x").slice(0, 8) + "0".repeat(56);

export function fnsDemoManifest() {
  return {
    schema: 1,
    release: "v3.0.1",
    channel: "stable",
    notes:
      "Demo catalog — a trimmed copy of the real release. Partial installs are the theme of this drop: tools that reach for each other now look first and stay quiet when the other side is absent.",
    base_url: "https://storage.functionstore.tools/fnstools",
    toolkit: {
      name: "FNSTools",
      td_build: "099",
      tiers: [
        { id: "8323905", label: "Base" },
        { id: "8291595", label: "Pro" },
        { id: "9796651", label: "Coaching" },
      ],
      support_url: "https://patreon.com/function_store",
    },
    core: CORE,
    categories: Object.keys(CATEGORY_META),
    category_meta: CATEGORY_META,
    packages: PKGS.map((p) => ({
      ...p,
      help_url: `https://tools.functionstore.xyz/docs/${p.name.toLowerCase()}/`,
      surfaces: [],
      requires: p.kind === "tool" ? ["FNS_ConfigRegistry"] : [],
      integrates_with: [],
      artifact: {
        path: `packaging/dist/${p.name}.tox`,
        bytes: 68470,
        sha256: sha(p.name),
        url: `https://storage.functionstore.tools/fnstools/v3.0.1/${p.name}.tox`,
      },
    })),
    rails: {
      "FNSTools.tox": { bytes: 161342, sha256: sha("boot"), url: "https://storage.functionstore.tools/fnstools/v3.0.1/FNSTools.tox" },
      "FNS_Installer.tox": { bytes: 17814, sha256: sha("inst"), url: "https://storage.functionstore.tools/fnstools/v3.0.1/FNS_Installer.tox" },
    },
  };
}

/** Mutable demo state: what's in the store and in the demo session. */
export const fnsState = {
  inStore: new Set<string>([...CORE, "FNS_Toolbar", "SwapOps", "AutoRes"]),
  stale: new Set<string>(["AutoRes"]),
  railsInStore: new Set<string>(["FNSTools"]),
  installed: new Map<string, string>([
    ["FNS_Toolbar", "1.1.0"], // older than the release → update badge
    ["SwapOps", "1.0.4"],
  ]),
  settingsServed: false,
  /** Tool names of the last written selection — what fns_install "lands". */
  lastSelection: [] as string[],
};

export function fnsDemoStoreStatus() {
  const m = fnsDemoManifest();
  return {
    storeDir: FNS_DEMO_STORE_DIR,
    paletteDir: FNS_DEMO_STORE_DIR.replace(/\\store$/, ""),
    storeRelease: "v3.0.1",
    configPath: CONFIG_PATH,
    configExists: true,
    artifacts: m.packages.map((p) => ({
      name: p.name,
      present: fnsState.inStore.has(p.name),
      shaOk: fnsState.inStore.has(p.name) ? !fnsState.stale.has(p.name) : null,
      bytes: fnsState.inStore.has(p.name) ? 68470 : 0,
    })),
    rails: ["FNSTools", "FNS_Installer"].map((name) => ({
      name,
      present: fnsState.railsInStore.has(name),
      shaOk: fnsState.railsInStore.has(name) ? true : null,
      bytes: fnsState.railsInStore.has(name) ? 161342 : 0,
    })),
  };
}

export function fnsDemoSessionStatus() {
  return {
    ok: true,
    present: fnsState.installed.size > 0,
    root: fnsState.installed.size > 0 ? "/FNSTools" : null,
    packages: [
      ...CORE.map((name) => ({ name, version: "2.0.0" })),
      ...[...fnsState.installed.entries()].map(([name, version]) => ({ name, version })),
    ],
    installer: "/FNSTools/FNS_Installer",
    installer_status: "idle",
    config_registry: fnsState.installed.size > 0,
  };
}

export function fnsDemoConfig() {
  return {
    path: CONFIG_PATH,
    exists: true,
    content: JSON.stringify(
      {
        schema: 1,
        tools: {
          // Since FNSTools backlog 24 the file carries each par's schema beside
          // its value (label/style/page/help, menus, CLAMPED min/max, group).
          // Every field is optional: SwapOps below is a pre-schema section, so
          // the offline editor's type-guessing fallback stays exercised.
          FNS_Toolbar: {
            pars: {
              Active: {
                mode: "BIND", val: true, eval: true, bindExpr: "parent.FNS.par.Toolbaractive",
                label: "Active", style: "Toggle", page: "Settings", order: 2,
                help: "Bound up to the toolkit root — edit there.",
              },
              Widgetscale: {
                mode: "CONSTANT", val: 1.0, eval: 1.0,
                label: "Widget Scale", style: "Float", page: "Settings", order: 0, min: 0.5, max: 2,
                help: "Scale of every toolbar widget.",
              },
              Showlabels: {
                mode: "CONSTANT", val: true, eval: true,
                label: "Show Labels", style: "Toggle", page: "Settings", order: 1,
                help: "Label each toolbar button.",
              },
              Side: {
                mode: "CONSTANT", val: "top", eval: "top",
                label: "Side", style: "Menu", page: "Settings", order: 3,
                menuNames: ["top", "bottom"], menuLabels: ["Top", "Bottom"],
                help: "Which edge of the network editor the bar docks to.",
              },
              Tintr: {
                mode: "CONSTANT", val: 0.2, eval: 0.2,
                label: "Tint", style: "RGB", page: "Settings", order: 4, min: 0, max: 1,
                group: "Tint", groupLabel: "Tint", help: "Bar background tint.",
              },
              Tintg: { mode: "CONSTANT", val: 0.2, eval: 0.2, style: "RGB", page: "Settings", order: 4, group: "Tint" },
              Tintb: { mode: "CONSTANT", val: 0.25, eval: 0.25, style: "RGB", page: "Settings", order: 4, group: "Tint" },
              Cfautoload: { mode: "CONSTANT", val: true, eval: true, label: "Autoload", style: "Toggle", page: "Config" },
            },
          },
          SwapOps: {
            pars: {
              Keepname: { mode: "CONSTANT", val: false, eval: false },
              Hotkey: { mode: "CONSTANT", val: "ctrl.alt.s", eval: "ctrl.alt.s" },
              Cfautoload: { mode: "CONSTANT", val: true, eval: true },
            },
          },
        },
      },
      null,
      1,
    ),
  };
}

/** The toolkit-wide config scope, as the console reports it. Mutable so the
 *  settings tab can flip it in the demo the way /api/scope does live. */
let demoScope: "global" | "project" = "global";
export function fnsDemoSetScope(value?: string, mode?: string) {
  if (value === undefined) return { ok: true, scope: demoScope };
  if (value === "global" && mode !== "push" && mode !== "adopt")
    return { ok: false, why: "flipping to global needs mode 'push' or 'adopt'" };
  if (value !== "global" && value !== "project") return { ok: false, why: "unknown scope: " + value };
  demoScope = value;
  return { ok: true, scope: demoScope };
}

export function fnsDemoUiState() {
  return {
    scope: demoScope,
    project: "AuroraSet",
    tools: [
      {
        name: "FNS_Toolbar",
        label: "Toolbar",
        path: "/FNSTools/FNS_Toolbar",
        version: "1.1.0",
        pars: [
          {
            name: "Widgetscale",
            label: "Widget Scale",
            page: "Settings",
            style: "Float",
            order: 0,
            min: 0.5,
            max: 2,
            help: "Scale of every toolbar widget.",
            pars: [{ name: "Widgetscale", val: 1.0, readonly: false, mode: "CONSTANT" }],
          },
          {
            name: "Showlabels",
            label: "Show Labels",
            page: "Settings",
            style: "Toggle",
            order: 1,
            help: "Label each toolbar button.",
            pars: [{ name: "Showlabels", val: true, readonly: false, mode: "CONSTANT" }],
          },
          {
            name: "Active",
            label: "Active",
            page: "Settings",
            style: "Toggle",
            order: 2,
            help: "Bound up to the toolkit root — edit there.",
            pars: [{ name: "Active", val: true, readonly: true, mode: "BIND" }],
          },
        ],
      },
      {
        name: "SwapOps",
        path: "/FNSTools/SwapOps",
        version: "1.0.4",
        pars: [
          {
            name: "Keepname",
            label: "Keep Names",
            page: "Settings",
            style: "Toggle",
            order: 0,
            help: "Swap wiring but keep each op's name in place.",
            pars: [{ name: "Keepname", val: false, readonly: false, mode: "CONSTANT" }],
          },
          {
            name: "Hotkey",
            label: "Hotkey",
            page: "Settings",
            style: "Str",
            order: 1,
            help: "Keyboard shortcut in TD hotkey syntax.",
            pars: [{ name: "Hotkey", val: "ctrl.alt.s", readonly: false, mode: "CONSTANT" }],
          },
        ],
      },
    ],
    config_path: CONFIG_PATH,
    project: "AuroraSet.toe",
  };
}

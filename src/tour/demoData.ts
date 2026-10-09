// -- Tour demo data -----------------------------------------------------------
// A tour that spotlights an empty pane teaches nothing — on a fresh install
// Recent, Current, Templates and Patreon are all empty, which is exactly when
// the tour runs. So while it's open, any list that would render empty is filled
// with plausible-looking stand-ins instead.
//
// These are display-only. The tour's backdrop swallows every click, so nothing
// can be selected, launched or killed; and the substitution is conditional on
// the real list being empty, so a user with real projects always sees their own.
//
// Paths use a scheme no real file can collide with, so a stray lookup by path
// can never match a genuine project.

import type { ListItem, TabId } from "../types";
import { demoArt } from "./demoArt";

/** Marks a row as fabricated — also what keeps it out of any real code path. */
export const DEMO_PREFIX = "tour-demo://";

export function isDemoPath(path: string): boolean {
  return path.startsWith(DEMO_PREFIX);
}

/** Epoch seconds, relative to now, for believable "started N ago" readouts. */
const ago = (mins: number) => Math.floor(Date.now() / 1000) - mins * 60;

const RECENT: ListItem[] = [
  {
    path: `${DEMO_PREFIX}Projects/AuroraSet/AuroraSet.toe`,
    displayName: "AuroraSet",
    missing: false,
    tags: ["show/live", "client/nordlys"],
  },
  {
    path: `${DEMO_PREFIX}Projects/ParticleWall/ParticleWall.toe`,
    displayName: "ParticleWall",
    missing: false,
    tags: ["installation"],
  },
  {
    path: `${DEMO_PREFIX}Projects/KinectRig/KinectRig.toe`,
    displayName: "KinectRig",
    missing: false,
    tags: ["rnd"],
  },
  {
    path: `${DEMO_PREFIX}Projects/StageMapping/StageMapping.toe`,
    displayName: "StageMapping",
    missing: false,
    tags: ["show/live", "mapping"],
  },
  {
    path: `${DEMO_PREFIX}Projects/AudioReactive/AudioReactive.toe`,
    displayName: "AudioReactive",
    missing: false,
    tags: ["rnd", "audio"],
  },
  {
    path: `${DEMO_PREFIX}Archive/OldTitleSeq/OldTitleSeq.toe`,
    displayName: "OldTitleSeq",
    missing: true,
    tags: [],
  },
];

const CURRENT: ListItem[] = [
  {
    path: `${DEMO_PREFIX}Projects/AuroraSet/AuroraSet.toe`,
    displayName: "AuroraSet",
    missing: false,
    openPid: 18244,
    openEnvoyPort: 9870,
    openEnvoyUp: true,
    openMcpAvailable: true,
    openUtilityAvailable: true,
    openUtilityVersion: "0.3.0",
    openVersionKey: "2025.30060",
    openStartedAt: ago(47),
  },
  {
    path: `${DEMO_PREFIX}Projects/StageMapping/StageMapping.toe`,
    displayName: "StageMapping",
    missing: false,
    openPid: 20918,
    openEnvoyPort: null,
    openEnvoyUp: null,
    openMcpAvailable: false,
    // The interesting case: running, but with no companion loaded.
    openUtilityAvailable: false,
    openVersionKey: "2025.30060",
    openStartedAt: ago(6),
  },
];

const TEMPLATES: ListItem[] = [
  {
    path: `${DEMO_PREFIX}Templates/Blank_1080p.toe`,
    displayName: "Blank_1080p",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Templates/LiveVisuals_Base.toe`,
    displayName: "LiveVisuals_Base",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Templates/Projection_4K.toe`,
    displayName: "Projection_4K",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Templates/AudioReactive_Starter.toe`,
    displayName: "AudioReactive_Starter",
    missing: false,
  },
];

const PALETTE: ListItem[] = [
  {
    path: `${DEMO_PREFIX}Palette/User/BloomStack.tox`,
    displayName: "BloomStack.tox",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Palette/User/CueList.tox`,
    displayName: "CueList.tox",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Palette/User/NDIRouter.tox`,
    displayName: "NDIRouter.tox",
    missing: false,
  },
  {
    path: `${DEMO_PREFIX}Palette/User/OSCBridge.tox`,
    displayName: "OSCBridge.tox",
    missing: false,
  },
];

const BY_TAB: Partial<Record<TabId, ListItem[]>> = {
  recent: RECENT,
  current: CURRENT,
  templates: TEMPLATES,
  palette: PALETTE,
};

/** Stand-in rows for a tab, or [] for tabs the tour doesn't fake (Patreon). */
export function demoItems(tab: TabId): ListItem[] {
  const rows = BY_TAB[tab] ?? [];
  // Projects get animated art (see demoArt); palette .tox rows keep their TOX tile.
  if (tab === "palette") return rows;
  return rows.map((r, i) => ({ ...r, heroUrl: r.missing ? null : demoArt(r.displayName, i) }));
}

/** Shown in the palette's "Load .tox into" picker when no session is running. */
export const DEMO_SESSION_NAME = "AuroraSet";

/**
 * Stand-in install list for the version panel, used only when the machine has
 * no TouchDesigner installs at all — otherwise the real ones are shown.
 */
export const DEMO_VERSION_KEYS = [
  "TouchDesigner.2023.12370",
  "TouchDesigner.2025.30060",
  "TouchDesigner.2025.32050",
];

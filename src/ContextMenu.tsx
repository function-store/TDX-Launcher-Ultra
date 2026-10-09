import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * One entry in a context menu: an action, a submenu, a section header, or a
 * separator. Items with `children` open a submenu instead of running an action.
 */
export type MenuEntry =
  | { type: "separator" }
  | { type: "header"; label: string }
  | {
      type?: "item";
      label: string;
      /** Small right-aligned hint (shortcut, detail, …). */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Tooltip explaining the action or why it is disabled. */
      title?: string;
      /**
       * Renders a check gutter: true = checked, false = unchecked. Every item
       * in the same list gets the gutter so labels stay aligned.
       */
      checked?: boolean;
      /** Keep the menu open after selecting — for toggles you flip in runs. */
      keepOpen?: boolean;
      onSelect?: () => void;
      children?: MenuEntry[];
    };

export type MenuState = { x: number; y: number; entries: MenuEntry[] };

/**
 * Position updater that keeps the previous object when the numbers are
 * unchanged. A caller may rebuild `entries` every render (live menus), which
 * re-runs the measure effect — without this bail-out that would loop forever.
 */
function samePos(left: number, top: number) {
  return (prev: { left: number; top: number } | null) =>
    prev && prev.left === left && prev.top === top ? prev : { left, top };
}

/** Drop leading/trailing separators and collapse runs — builders can be sloppy. */
function normalizeEntries(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.type === "separator") {
      if (out.length === 0 || out[out.length - 1].type === "separator") continue;
    }
    out.push(e);
  }
  while (out.length && out[out.length - 1].type === "separator") out.pop();
  return out;
}

function MenuList({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<{ index: number; anchor: DOMRect } | null>(null);
  const list = normalizeEntries(entries);
  // One checkable item gives the whole list a gutter, so labels line up.
  const hasChecks = list.some((e) => e.type !== "separator" && e.type !== "header" && "checked" in e);
  return (
    <>
      {list.map((entry, i) => {
        if (entry.type === "separator") return <div key={i} className="ctx-sep" />;
        if (entry.type === "header") {
          return (
            <div key={i} className="ctx-header" title={entry.label}>
              {entry.label}
            </div>
          );
        }
        const hasSub = !!entry.children?.length;
        return (
          <div
            key={i}
            className={[
              "ctx-item",
              entry.danger ? "danger" : "",
              entry.disabled ? "disabled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={entry.title}
            onMouseEnter={(e) =>
              setOpenSub(
                hasSub && !entry.disabled
                  ? { index: i, anchor: e.currentTarget.getBoundingClientRect() }
                  : null,
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              if (entry.disabled || hasSub) return;
              if (!entry.keepOpen) onClose();
              entry.onSelect?.();
            }}
          >
            {hasChecks ? (
              <span className="ctx-check" aria-hidden>
                {entry.checked ? "✓" : ""}
              </span>
            ) : null}
            <span className="ctx-label">{entry.label}</span>
            {entry.hint ? <span className="ctx-hint">{entry.hint}</span> : null}
            {hasSub ? <span className="ctx-caret">▸</span> : null}
            {hasSub && openSub?.index === i && (
              <SubPanel entries={entry.children!} anchor={openSub.anchor} onClose={onClose} />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Nested panel beside its parent item. Fixed-positioned from the item's
 * viewport rect — a child of the scrollable menu would be clipped by its
 * `overflow` — and flipped when it would leave the viewport.
 */
function SubPanel({
  entries,
  anchor,
  onClose,
}: {
  entries: MenuEntry[];
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.right - 2;
    let top = anchor.top - 5;
    if (left + r.width > window.innerWidth - 4) {
      left = Math.max(4, anchor.left - r.width + 2);
    }
    if (top + r.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - r.height - 4);
    }
    setPos(samePos(left, top));
  }, [entries, anchor]);
  return (
    <div
      ref={ref}
      className="ctx-menu ctx-submenu"
      style={{
        left: pos?.left ?? anchor.right,
        top: pos?.top ?? anchor.top,
        visibility: pos ? "visible" : "hidden",
      }}
      role="menu"
    >
      <MenuList entries={entries} onClose={onClose} />
    </div>
  );
}

/**
 * App-styled context menu. Render once with the current open-state; `null`
 * renders nothing. Closes on outside press, Escape (captured before the app's
 * global Escape handling), a wheel or touch scroll, resize, and window blur.
 */
export default function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - r.width - 4);
    }
    if (top + r.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - r.height - 4);
    }
    setPos(samePos(left, top));
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".ctx-menu")) return;
      // A menu-bar button owns its own open/close — closing here first would
      // make its click handler see a closed menu and immediately reopen it.
      if (t?.closest?.("[data-ctx-menu-trigger]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation so the app's Escape (quit) never sees it.
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    // A user scroll gesture closes the menu; a `scroll` event does not. The
    // app scrolls on its own right after a right-click — the clicked row is
    // brought fully into view, and the version list jumps to the build the
    // analysis found — and listening for `scroll` cancelled the very menu
    // that caused it. A scrollbar drag is a mousedown, handled above.
    const onScrollGesture = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".ctx-menu")) return; // scrolling a long menu itself is fine
      onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onScrollGesture, { capture: true, passive: true });
    window.addEventListener("touchmove", onScrollGesture, { capture: true, passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onScrollGesture, true);
      window.removeEventListener("touchmove", onScrollGesture, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        // Invisible until measured/clamped so a near-edge open never flashes.
        visibility: pos ? "visible" : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList entries={menu.entries} onClose={onClose} />
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HintDef } from "./hints";
import "./hints.css";

interface Props {
  hint: HintDef;
  /** Fired once the bubble is actually on screen — the cue to retire the hint. */
  onShown: () => void;
  /** The anchor never rendered; drop the hint without burning it. */
  onMiss: () => void;
  onDismiss: () => void;
  /** Turn the whole hint system off — offered on every bubble. */
  onDisableAll: () => void;
}

const W = 268;
const GAP = 10;
const BEAK = 7;
/** How long we'll wait for the anchor to appear before giving up on the hint. */
const MISS_MS = 2000;

type Side = "top" | "bottom" | "left" | "right";

/**
 * A single first-encounter hint: a small bubble beside the element the user
 * just reached for, plus a soft ring on the element itself. Unlike the tour it
 * never blocks — the app stays fully usable underneath, and any click, Esc, or
 * a scroll that moves the anchor away dismisses it.
 */
export default function HintBubble({ hint, onShown, onMiss, onDismiss, onDisableAll }: Props) {
  const [pos, setPos] = useState<{ left: number; top: number; side: Side; beak: number } | null>(null);
  const [ring, setRing] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);

  const measure = useCallback(() => {
    const el = document.querySelector(hint.target);
    if (!el) {
      setPos(null);
      setRing(null);
      return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      setPos(null);
      setRing(null);
      return false;
    }
    const h = ref.current?.offsetHeight ?? 150;

    const fits: Record<Side, boolean> = {
      bottom: r.bottom + GAP + h + 12 < window.innerHeight,
      top: r.top - GAP - h - 12 > 0,
      right: r.right + GAP + W + 12 < window.innerWidth,
      left: r.left - GAP - W - 12 > 0,
    };
    const preferred = hint.placement ?? "bottom";
    const order: Side[] = [preferred, "bottom", "top", "right", "left"];
    const side = order.find((s) => fits[s]) ?? "bottom";

    let left: number;
    let top: number;
    if (side === "bottom" || side === "top") {
      left = r.left + r.width / 2 - W / 2;
      top = side === "bottom" ? r.bottom + GAP : r.top - GAP - h;
    } else {
      left = side === "right" ? r.right + GAP : r.left - GAP - W;
      top = r.top + r.height / 2 - h / 2;
    }
    const clampedLeft = Math.max(12, Math.min(left, window.innerWidth - W - 12));
    const clampedTop = Math.max(12, Math.min(top, window.innerHeight - h - 12));

    const beak =
      side === "bottom" || side === "top"
        ? Math.max(18, Math.min(r.left + r.width / 2 - clampedLeft, W - 18))
        : Math.max(18, Math.min(r.top + r.height / 2 - clampedTop, h - 18));

    setPos({ left: clampedLeft, top: clampedTop, side, beak });
    setRing({ left: r.left - 4, top: r.top - 4, width: r.width + 8, height: r.height + 8 });
    return true;
  }, [hint]);

  // Poll briefly for the anchor — it may still be mounting when the hint fires.
  useLayoutEffect(() => {
    let cancelled = false;
    const start = performance.now();
    const tick = () => {
      if (cancelled) return;
      const found = measure();
      if (found) {
        if (!shownRef.current) {
          shownRef.current = true;
          onShown();
        }
        return;
      }
      if (performance.now() - start > MISS_MS) {
        onMiss();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint]);

  // Keep it glued to the anchor while the layout shifts around it.
  useEffect(() => {
    const onMove = () => {
      if (!measure()) onDismiss();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [measure, onDismiss]);

  // Any click outside, or Esc, closes it. Everything else stays interactive.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // Deferred so the very click that triggered the hint doesn't close it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey);
    }, 60);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const beakStyle =
    pos == null
      ? undefined
      : pos.side === "bottom"
        ? { top: -BEAK, left: pos.beak - BEAK }
        : pos.side === "top"
          ? { bottom: -BEAK, left: pos.beak - BEAK }
          : pos.side === "right"
            ? { left: -BEAK, top: pos.beak - BEAK }
            : { right: -BEAK, top: pos.beak - BEAK };

  return (
    <>
      {ring && (
        <div
          className="hint-ring"
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
        />
      )}
      <div
        ref={ref}
        className={`hint-bubble${pos ? ` hint-bubble--${pos.side}` : " hint-bubble--hidden"}`}
        style={pos ? { left: pos.left, top: pos.top } : undefined}
        role="dialog"
        aria-label={hint.title}
      >
        {pos && (
          <span className={`hint-beak hint-beak--${pos.side}`} style={beakStyle} />
        )}
        <div className="hint-head">
          <span className="hint-kicker">Tip</span>
          <button
            type="button"
            className="hint-x"
            aria-label="Dismiss tip"
            onClick={onDismiss}
          >
            ×
          </button>
        </div>
        <div className="hint-title">{hint.title}</div>
        <div className="hint-body" dangerouslySetInnerHTML={{ __html: hint.body }} />
        <div className="hint-foot">
          <button
            type="button"
            className="hint-off"
            title="Never show first-encounter tips again (Help can turn them back on)"
            onClick={onDisableAll}
          >
            Don&apos;t show tips
          </button>
          <button type="button" className="hint-ok" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </>
  );
}

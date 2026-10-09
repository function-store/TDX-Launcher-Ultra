import { useCallback, useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

type Props = {
  axis: Axis;
  onDelta: (deltaPx: number) => void;
  title?: string;
};

/** Thin drag handle for resizing adjacent panes. */
export default function SplitHandle({ axis, onDelta, title }: Props) {
  const [active, setActive] = useState(false);
  const last = useRef(0);
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = axis === "x" ? e.clientX : e.clientY;
      setActive(true);
    },
    [axis],
  );

  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      const pos = axis === "x" ? e.clientX : e.clientY;
      const delta = pos - last.current;
      last.current = pos;
      if (delta !== 0) onDeltaRef.current(delta);
    };
    const onUp = () => setActive(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [active, axis]);

  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prev;
      document.body.style.userSelect = prevSelect;
    };
  }, [active, axis]);

  return (
    <div
      className={`split-handle split-handle-${axis}${active ? " active" : ""}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title={title ?? (axis === "x" ? "Drag to resize" : "Drag to resize")}
      onPointerDown={onPointerDown}
    >
      <span className="split-grip" aria-hidden />
    </div>
  );
}

const LS_LIST = "tdxlu.split.listHeight";
const LS_SIDE = "tdxlu.split.sideWidth";

function readNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Persist a pane size in localStorage (px). */
export function useStoredPx(
  key: string,
  defaultPx: number,
  min: number,
  max: number,
) {
  const [value, setValue] = useState(() => readNum(key, defaultPx, min, max));
  const set = useCallback(
    (next: number | ((prev: number) => number)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? next(prev) : next;
        const clamped = Math.min(max, Math.max(min, v));
        try {
          localStorage.setItem(key, String(Math.round(clamped)));
        } catch {
          /* ignore */
        }
        return clamped;
      });
    },
    [key, min, max],
  );
  return [value, set] as const;
}

export function useListPaneHeight(defaultPx = 280) {
  return useStoredPx(LS_LIST, defaultPx, 120, 900);
}

export function useSidePaneWidth(defaultPx = 420) {
  return useStoredPx(LS_SIDE, defaultPx, 280, 900);
}

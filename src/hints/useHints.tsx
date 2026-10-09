import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearHintsSeen,
  loadHintsDisabled,
  loadHintsSeen,
  saveHintsDisabled,
  saveHintsSeen,
} from "../uiPersist";
import HintBubble from "./HintBubble";
import { buildHints, type HintId } from "./hints";

interface Options {
  /** False while the tour / wizard / a modal owns the screen — hints wait. */
  enabled: boolean;
  mod: string;
  isMac: boolean;
}

/**
 * Settle delay so the panel the hint describes is painted first — and so two
 * hints that fire back to back get a beat between them.
 */
const SHOW_DELAY_MS = 420;

/**
 * First-encounter hints. `showHint(id)` is a no-op once that hint has been
 * seen (persisted), while it's suppressed, or if it's already queued — so call
 * sites can fire it unconditionally from a click or an effect.
 */
export function useHints({ enabled: screenFree, mod, isMac }: Options) {
  const defs = useMemo(() => buildHints({ mod, isMac }), [mod, isMac]);
  const seenRef = useRef<Set<string>>(loadHintsSeen());
  const [queue, setQueue] = useState<HintId[]>([]);
  const [active, setActive] = useState<HintId | null>(null);
  /** User's standing "no tips, ever" choice — outlives the session. */
  const [hintsOff, setHintsOff] = useState(loadHintsDisabled);
  const enabled = screenFree && !hintsOff;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const showHint = useCallback((id: HintId) => {
    if (!enabledRef.current) return;
    if (seenRef.current.has(id)) return;
    setQueue((q) => (q.includes(id) ? q : [...q, id]));
  }, []);

  /** "Don't show tips" — off for good, and drop anything already queued. */
  const disableHints = useCallback(() => {
    setHintsOff(true);
    saveHintsDisabled(true);
    setQueue([]);
    setActive(null);
  }, []);

  // Pull the next hint off the queue once the screen is free.
  useEffect(() => {
    if (active || !enabled) return;
    const next = queue.find((id) => !seenRef.current.has(id));
    if (!next) return;
    const t = setTimeout(() => {
      setActive(next);
      setQueue((q) => q.filter((id) => id !== next));
    }, SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [active, enabled, queue]);

  // Something took over the screen mid-hint. If it had already rendered the
  // user has seen it — drop it. If it never made it on screen, requeue.
  useEffect(() => {
    if (enabled || !active) return;
    if (!seenRef.current.has(active)) {
      setQueue((q) => (q.includes(active) ? q : [active, ...q]));
    }
    setActive(null);
  }, [enabled, active]);

  const finish = useCallback(() => {
    setActive(null);
  }, []);

  const markShown = useCallback((id: HintId) => {
    if (seenRef.current.has(id)) return;
    seenRef.current.add(id);
    saveHintsSeen(seenRef.current);
  }, []);

  /** Re-arm every hint (Help → Show tips again) — also undoes "don't show". */
  const resetHints = useCallback(() => {
    seenRef.current = new Set();
    clearHintsSeen();
    setHintsOff(false);
    saveHintsDisabled(false);
    setQueue([]);
    setActive(null);
  }, []);

  const hintNode =
    active && enabled ? (
      <HintBubble
        key={active}
        hint={defs[active]}
        onShown={() => markShown(active)}
        // Anchor never appeared (wrong tab, feature hidden) — leave it un-seen
        // so the hint gets another chance next time.
        onMiss={finish}
        onDismiss={() => {
          markShown(active);
          setActive(null);
        }}
        onDisableAll={disableHints}
      />
    ) : null;

  return { showHint, hintNode, resetHints, disableHints, hintsOff };
}

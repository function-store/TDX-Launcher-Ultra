import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { THEMES, type ThemeId } from "../types";
import { TAB_LABELS, type TourStep } from "./tourSteps";
import "./tour.css";

interface Props {
  steps: TourStep[];
  /** `finished` is false when the user bailed (Skip / Escape) rather than
   *  paging through to the last step — App uses it to not chain the setup
   *  wizard onto an opt-out. */
  onClose: (finished?: boolean) => void;
  theme: ThemeId;
  onThemeChange: (t: ThemeId) => void;
  /**
   * Fired for the step that is about to become visible — before the card has
   * faded back in, so App can switch tabs while the overlay hides the churn.
   */
  onStepEnter?: (step: TourStep, index: number) => void;
  /** Open Function Store's Patreon join page (the last card's support ask). */
  onSupport?: () => void;
}

const SPOT_PAD_DEFAULT = 8;
const SPOT_RX = 8;
const CARD_W = 320;
const CARD_GAP = 14;
const BEAK = 9;
/** Card fade-out length. The tab switch happens at the start of it. */
const TRANSITION_MS = 190;
/** Re-measure schedule after a step change — a tab switch re-renders the pane. */
const SETTLE_MS = [0, 40, 110, 240, 420, 700];

type Side = "top" | "bottom" | "left" | "right" | "center";
type Beak = { side: Side; offset: number } | null;

/**
 * First-run tour: darkens the app behind an SVG mask, cuts a spotlight hole
 * around the current step's target, and anchors an explainer card beside it.
 * Steps carry a tab, so the tour drives the app as it narrates.
 * Steps whose target is null (or missing from the DOM) get a centered card.
 */
export default function TourOverlay({ steps, onClose, theme, onThemeChange, onStepEnter, onSupport }: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [cardPos, setCardPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [beak, setBeak] = useState<Beak>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Kept in a ref so a changing callback identity can't retrigger the tab switch.
  const enterRef = useRef(onStepEnter);
  enterRef.current = onStepEnter;

  const step = steps[stepIdx];
  const pad = step.spotlightPad ?? SPOT_PAD_DEFAULT;

  // -- Measure target + position card -----------------------------------------
  const measure = useCallback(() => {
    const ch = cardRef.current?.offsetHeight ?? 200;

    if (!step.target) {
      setRect(null);
      setBeak(null);
      return; // CSS handles centering
    }
    const el = document.querySelector(step.target);
    if (!el) {
      setRect(null);
      setBeak(null);
      return; // CSS fallback centers the card until the target renders
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();

    // Off-screen or collapsed target → centered card
    if (
      r.width < 2 ||
      r.height < 2 ||
      r.bottom < 0 ||
      r.top > window.innerHeight ||
      r.right < 0 ||
      r.left > window.innerWidth
    ) {
      setRect(null);
      setBeak(null);
      return;
    }

    setRect(r);

    let left = 0;
    let top = 0;
    const fitsRight = r.right + CARD_GAP + CARD_W + 16 < window.innerWidth;
    const fitsLeft = r.left - CARD_GAP - CARD_W - 16 > 0;
    const fitsBelow = r.bottom + CARD_GAP + ch + 16 < window.innerHeight;
    const fitsAbove = r.top - CARD_GAP - ch - 16 > 0;
    const auto = fitsRight ? "right" : fitsLeft ? "left" : fitsBelow ? "bottom" : fitsAbove ? "top" : "center";
    // For explicit placements, fall back to center if there's not enough room
    const fits = { right: fitsRight, left: fitsLeft, bottom: fitsBelow, top: fitsAbove, center: true, auto: true };
    const placement: Side = step.placement === "auto" ? auto : fits[step.placement] ? step.placement : "center";

    switch (placement) {
      case "right":
        left = r.right + CARD_GAP + pad;
        top = r.top + r.height / 2 - ch / 2;
        break;
      case "left":
        left = r.left - CARD_GAP - CARD_W - pad;
        top = r.top + r.height / 2 - ch / 2;
        break;
      case "bottom":
        left = r.left + r.width / 2 - CARD_W / 2;
        top = r.bottom + CARD_GAP + pad;
        break;
      case "top":
        left = r.left + r.width / 2 - CARD_W / 2;
        top = r.top - CARD_GAP - ch - pad;
        break;
      case "center":
        left = (window.innerWidth - CARD_W) / 2;
        top = (window.innerHeight - ch) / 2;
        break;
    }

    left = Math.max(16, Math.min(left, window.innerWidth - CARD_W - 16));
    top = Math.max(16, Math.min(top, window.innerHeight - ch - 16));
    setCardPos({ left, top });

    // Beak points back at the target from whichever edge faces it. Clamped so
    // it never slides off a rounded corner after the card was nudged on-screen.
    if (placement === "center") {
      setBeak(null);
    } else {
      const horizontal = placement === "left" || placement === "right";
      const raw = horizontal
        ? r.top + r.height / 2 - top
        : r.left + r.width / 2 - left;
      const span = horizontal ? ch : CARD_W;
      const offset = Math.max(18, Math.min(raw, span - 18));
      // The beak sits on the card edge nearest the target — the opposite side
      // of where the card was placed relative to it.
      const side: Side =
        placement === "right" ? "left" : placement === "left" ? "right" : placement === "bottom" ? "top" : "bottom";
      setBeak({ side, offset });
    }
  }, [step, pad]);

  // Measure after step change, then again as the new tab's pane settles
  useLayoutEffect(() => {
    measure();
    const raf = requestAnimationFrame(() => measure());
    const timers = SETTLE_MS.map((ms) => setTimeout(() => measure(), ms));
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [measure]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  // Card height changes as step content settles — reposition
  useEffect(() => {
    if (!cardRef.current) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // The first step needs its tab too — the overlay mounts on whatever was open.
  useEffect(() => {
    enterRef.current?.(steps[0], 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard navigation (App.tsx suppresses its own shortcuts while the tour is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose(false);
        return;
      }
      // The card holds real controls (theme <select>, nav buttons). A focused
      // form field owns its keys entirely; a focused button keeps Enter/Space
      // (activation) while the arrows still page the tour. Only card controls
      // get this — anything still focused BEHIND the backdrop must not see
      // Enter, so outside the card every key means "advance" as before.
      const el = e.target instanceof HTMLElement ? e.target : null;
      const inCard = !!el && !!cardRef.current && cardRef.current.contains(el);
      const tag = inCard ? el.tagName : undefined;
      if (tag === "SELECT" || tag === "OPTION" || tag === "INPUT" || tag === "TEXTAREA") return;
      const onButton = tag === "BUTTON";
      if (e.key === "ArrowRight" || (!onButton && (e.key === "Enter" || e.key === " "))) {
        e.preventDefault();
        goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // intentionally no deps — always uses latest stepIdx via closures

  const goTo = (next: number) => {
    if (transitioning || next === stepIdx || next < 0 || next >= steps.length) return;
    // Switch tabs now, under the fade-out, so the pane is painted by the time
    // the card comes back and the spotlight measures.
    enterRef.current?.(steps[next], next);
    setTransitioning(true);
    setTimeout(() => {
      setStepIdx(next);
      setTransitioning(false);
    }, TRANSITION_MS);
  };

  const goNext = () => {
    if (step.isLast) {
      onClose(true);
      return;
    }
    goTo(stepIdx + 1);
  };

  const goPrev = () => goTo(stepIdx - 1);

  // Hole rect coordinates (with padding)
  const hx = rect ? rect.left - pad : 0;
  const hy = rect ? rect.top - pad : 0;
  const hw = rect ? rect.width + pad * 2 : 0;
  const hh = rect ? rect.height + pad * 2 : 0;

  const beakStyle = beak
    ? beak.side === "left"
      ? { left: -BEAK, top: beak.offset - BEAK }
      : beak.side === "right"
        ? { right: -BEAK, top: beak.offset - BEAK }
        : beak.side === "top"
          ? { top: -BEAK, left: beak.offset - BEAK }
          : { bottom: -BEAK, left: beak.offset - BEAK }
    : undefined;

  return (
    <>
      {/* Click blocker — prevents interaction outside the spotlight */}
      <div className="tour-backdrop" onClick={(e) => e.stopPropagation()} />

      {/* Darkening overlay with the spotlight hole */}
      <svg className="tour-svg-mask">
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                className="tour-hole"
                x={hx}
                y={hy}
                width={hw}
                height={hh}
                rx={SPOT_RX}
                ry={SPOT_RX}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.72)"
          mask="url(#tour-mask)"
        />
      </svg>

      {/* Accent ring around the target (plus a slow halo pulse) */}
      {rect && (
        <svg className="tour-ring-svg">
          <rect
            className="tour-ring tour-ring--halo"
            x={hx}
            y={hy}
            width={hw}
            height={hh}
            rx={SPOT_RX}
            ry={SPOT_RX}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
          />
          <rect
            className="tour-ring"
            x={hx}
            y={hy}
            width={hw}
            height={hh}
            rx={SPOT_RX}
            ry={SPOT_RX}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeOpacity="0.75"
          />
        </svg>
      )}

      {/* Explainer card */}
      <div
        ref={cardRef}
        className={`tour-card${transitioning ? " tour-card--transitioning" : ""}`}
        style={
          step.target && rect
            ? { left: cardPos.left, top: cardPos.top }
            : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        {beak && <span className={`tour-beak tour-beak--${beak.side}`} style={beakStyle} />}
        <div className="tour-badge-row">
          <span className="tour-badge">
            {step.isLast ? "Done" : `Step ${stepIdx + 1} / ${steps.length}`}
          </span>
          {step.tab && <span className="tour-tabchip">{TAB_LABELS[step.tab]}</span>}
        </div>
        <div className="tour-title">{step.title}</div>
        <div className="tour-body" dangerouslySetInnerHTML={{ __html: step.body }} />
        {step.showThemePicker && (
          <div className="tour-theme-picker">
            <span className="tour-theme-picker__label">Color theme</span>
            <select value={theme} onChange={(e) => onThemeChange(e.target.value as ThemeId)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {step.showSupport && onSupport && (
          <div className="tour-support">
            <p>
              TDXLU is free and made by Function Store. If it earns a place in your
              workflow, supporting it on Patreon keeps it going — and members get the
              FNSTools Plus packages.
            </p>
            <button type="button" className="tour-support__btn" onClick={onSupport}>
              ♥ Support on Patreon
            </button>
          </div>
        )}
        <div className="tour-progress">
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              aria-label={s.title}
              title={s.title}
              className={`tour-dot${i === stepIdx ? " tour-dot--active" : i < stepIdx ? " tour-dot--done" : ""}`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
        <div className="tour-nav">
          <button type="button" className="tour-nav__skip" onClick={() => onClose(false)}>
            Skip tour
          </button>
          <span className="tour-keyhint">← →</span>
          <button type="button" className="tour-nav__prev" onClick={goPrev} disabled={stepIdx === 0}>
            Back
          </button>
          <button type="button" className="tour-nav__next" onClick={goNext}>
            {step.isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}

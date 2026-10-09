// -- Patreon guidance, one source for every surface ---------------------------
//
// The Patreon tab exists in three places that share no styling: the launcher's
// tab (`PatreonPanel`), its Settings group (`App.tsx`), and the page TD's
// Palette Browser shows (`palette-standalone.tsx`) — plus the first-encounter
// hint and the tour card. The *facts* have to be identical in all of them, so
// they live here once and each surface only supplies its own class names.
//
// Copy is inline HTML, matching the convention in `src/hints/hints.ts` and
// `src/tour/tourSteps.ts` — that way a hint bubble and a rendered banner can
// use the very same string.

/**
 * What the Patreon tab actually is, in one line. The short form — for places
 * that are already narrow (the tab's empty state, the in-TD palette page).
 */
export const PATREON_UNOFFICIAL_SHORT =
  "<b>Unofficial.</b> This drives Patreon's private web API with your own login, so you only ever see what your account can already access. It is not a Patreon integration and Function Store is not affiliated with Patreon — Patreon can change that API at any time and this tab will simply stop working.";

/**
 * The credential half, for Settings — where the cookie is actually pasted and
 * the consequences are worth spelling out. `session_id` is not a scoped API
 * token; it is the whole account.
 */
export const PATREON_COOKIE_WARNING =
  "Your <code>session_id</code> is a <b>full-account credential</b>, not a scoped API token — whoever holds it is signed in as you, with no password and no second factor. TDXLU stores it unencrypted in <code>config.json</code>, so treat that file like a password: don't share it, don't commit it, and don't screen-record this page. Signing out of patreon.com in a normal browser invalidates it, and this tab stops loading until you log in again.";

/**
 * The safety warning — the one thing none of the other copy says. Shown once,
 * dismissable, shared across the launcher and the in-TD page via the
 * `patreon_trust_ack` pref (see `config.rs`).
 *
 * It is deliberately not a hint bubble: a hint is dismissed by clicking
 * anywhere, which is far too easy to blow past for something that decides
 * whether a stranger's code runs on this machine.
 */
export const PATREON_TRUST_TITLE = "A .tox runs its creator's code";

export const PATREON_TRUST_BODY =
  "A component is a program, not a document. Placing one into TouchDesigner runs whatever Python, callbacks and startup scripts it carries — with your file access, your network, your machine. Nothing here is scanned, reviewed or sandboxed by Function Store or by Patreon.\n\nPlace components from creators you actually trust. For an unfamiliar one, open it in a scratch project first rather than in the show file.";

/** Where the dismissed warning comes back from, named the way the UI names it. */
export const PATREON_TRUST_RESTORE = "Help → Show them again";

/**
 * Renders one of the HTML strings above. Newlines become paragraph breaks so a
 * single constant can carry more than one sentence-group.
 */
function Html({ html, className }: { html: string; className?: string }) {
  return (
    <>
      {html.split("\n\n").map((para, i) => (
        <p key={i} className={className} dangerouslySetInnerHTML={{ __html: para }} />
      ))}
    </>
  );
}

/**
 * The dismissable trust warning.
 *
 * `variant` only picks the class prefix — `app` for the launcher window
 * (App.css) and `pt` for the palette page (palette.css). The words are the same
 * either way, which is the entire point of this module.
 */
export function PatreonTrustNotice({
  variant,
  onDismiss,
  busy,
}: {
  variant: "app" | "palette";
  onDismiss: () => void;
  /** Dismissal is a round trip on the palette page — don't let it double-fire. */
  busy?: boolean;
}) {
  const root = variant === "app" ? "patreon-trust" : "pt-trust";
  return (
    <div className={root} role="note">
      <div className={`${root}-head`}>
        <span className={`${root}-icon`} aria-hidden="true">
          ⚠
        </span>
        <strong>{PATREON_TRUST_TITLE}</strong>
      </div>
      <Html html={PATREON_TRUST_BODY} className={`${root}-body`} />
      <div className={`${root}-actions`}>
        <button type="button" disabled={busy} onClick={onDismiss}>
          Got it
        </button>
        {variant === "app" && (
          <span className={`${root}-restore`}>
            Shown once — {PATREON_TRUST_RESTORE} brings it back.
          </span>
        )}
      </div>
    </div>
  );
}

/** The unofficial-API note, rendered for whichever surface asks for it. */
export function PatreonUnofficialNote({ className }: { className?: string }) {
  return <Html html={PATREON_UNOFFICIAL_SHORT} className={className} />;
}

/** The credential warning. Settings only — it is about the paste box. */
export function PatreonCookieNote({ className }: { className?: string }) {
  return <Html html={PATREON_COOKIE_WARNING} className={className} />;
}

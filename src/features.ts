/**
 * Build-time feature switches.
 *
 * These exist so an unfinished surface can be hidden without deleting it —
 * flip one constant to bring the whole feature back, rather than
 * reconstructing what was removed from a diff.
 */

/**
 * FNSTools: the dedicated tab, the Palette tab's FNS shelf, the
 * Settings section, its entry in Settings search, and the Alt+6 shortcut.
 *
 * Everything FNS keys off this single constant. If you add another FNS
 * surface, gate it here too — a half-hidden feature is worse than a visible
 * one, because the leftovers are the part nobody tests.
 */
export const FNS_ENABLED = true;

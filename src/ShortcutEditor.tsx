import { EDITABLE_ACTIONS, bindingFor, displayAccel, type ActionId } from "./keybindings";
import { FNS_ENABLED } from "./features";

/**
 * Interactive editor for the customizable keyboard shortcuts. Shared by
 * Settings and Help. Recording state lives in the parent (the global capture
 * effect handles the actual keychord); this just renders rows and dispatches.
 */
export default function ShortcutEditor({
  overrides,
  patreonEnabled,
  isMac,
  recording,
  onRecord,
  onReset,
  onResetAll,
}: {
  overrides: Record<string, string> | undefined;
  patreonEnabled: boolean;
  isMac: boolean;
  recording: ActionId | null;
  onRecord: (id: ActionId) => void;
  onReset: (id: ActionId) => void;
  onResetAll: () => void;
}) {
  const actions = EDITABLE_ACTIONS.filter(
    (a) => (!a.patreonOnly || patreonEnabled) && (!a.fnsOnly || FNS_ENABLED),
  );
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
  return (
    <>
      <div className="shortcut-list">
        {actions.map((a) => {
          const current = bindingFor(a, overrides, isMac);
          const overridden = !!overrides?.[a.id];
          return (
            <div className="shortcut-row" key={a.id}>
              <span className="shortcut-label">{a.label}</span>
              <button
                type="button"
                className={`shortcut-key${recording === a.id ? " recording" : ""}`}
                onClick={() => onRecord(a.id)}
                title="Click, then press the new keys (Esc cancels)"
              >
                {recording === a.id ? (
                  "Press keys…"
                ) : current ? (
                  displayAccel(current, isMac)
                ) : (
                  <span className="shortcut-unbound">Unbound</span>
                )}
              </button>
              <button
                type="button"
                className="small"
                disabled={!overridden}
                title="Reset to default"
                onClick={() => onReset(a.id)}
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" disabled={!hasOverrides} onClick={onResetAll}>
          Reset all to defaults
        </button>
      </div>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { THEMES, type AppConfig } from "../types";
import {
  CLI_FALLBACK_ASK,
  CLI_FALLBACK_CLOSEST,
  CLI_FALLBACK_LATEST,
  CLI_FALLBACK_UNSET,
  mainlineVersionKeys,
  newestMainlineKey,
  versionNumeric,
} from "../utils";
import "./wizard.css";

interface Props {
  isMac: boolean;
  config: AppConfig;
  updatePref: (patch: Partial<AppConfig>) => Promise<void>;
  /** Installed TD builds, for the file-association step's fallback picker. */
  versionKeys: string[];
  patreonEnabled: boolean;
  /** Whether the utility TOX ships inside this build (one-click install). */
  bundledUtility: boolean;
  onInstallUtility: () => Promise<void>;
  onDownloadUtility: () => void;
  autostartEnabled: boolean | null;
  onToggleAutostart: (on: boolean) => Promise<void>;
  hotkeyStatus: string | null;
  onToggleHotkey: (on: boolean) => void;
  hotkeyStatusMain: string | null;
  onToggleHotkeyMain: (on: boolean) => void;
  /**
   * Finish the wizard and open the Settings modal, scrolled to a section
   * (a `data-settings-section` value in App.tsx, e.g. "github").
   */
  onOpenSettings: (section?: string) => void;
  /** Finish or skip — the caller marks the wizard as seen. */
  onClose: () => void;
}

interface WizardStep {
  id: string;
  title: string;
  render: () => React.ReactNode;
}

/**
 * Post-install setup wizard: one short pass over the choices worth making on a
 * fresh install (look, file association, companion TOX, tray behavior) plus
 * pointers to the optional integrations. Shown once after the first-run tour
 * ends — including when the tour is skipped — and re-openable from Help.
 */
export default function SetupWizard({
  isMac,
  config,
  updatePref,
  versionKeys,
  patreonEnabled,
  bundledUtility,
  onInstallUtility,
  onDownloadUtility,
  autostartEnabled,
  onToggleAutostart,
  hotkeyStatus,
  onToggleHotkey,
  hotkeyStatusMain,
  onToggleHotkeyMain,
  onOpenSettings,
  onClose,
}: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [utilState, setUtilState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [utilError, setUtilError] = useState("");
  const [hotkeyDraft, setHotkeyDraft] = useState(config.global_hotkey ?? "");
  const [hotkeyMainDraft, setHotkeyMainDraft] = useState(config.global_hotkey_main ?? "");

  const installUtility = async () => {
    setUtilState("busy");
    try {
      await onInstallUtility();
      setUtilState("done");
    } catch (e) {
      setUtilError(String(e));
      setUtilState("error");
    }
  };

  const pickBackupRoot = async () => {
    const folder = await api.pickFolder("Choose backup root folder");
    if (folder) await updatePref({ backup_root: folder });
  };

  const steps = useMemo<WizardStep[]>(() => {
    const list: WizardStep[] = [
      {
        id: "fileassoc",
        title: "Open .toe files with the launcher",
        render: () => (
          <>
            <p>
              A few one-time choices — about a minute. Everything here (and much more) lives in{" "}
              <strong>Settings</strong> later. Starting with the one that does the most work:
            </p>
            <p>
              Make this the default app for <code>.toe</code> files so double-clicking a project
              opens the launcher with auto version detection (and a 5-second auto-launch
              countdown).
            </p>
            {isMac ? (
              <p className="help-tip">
                Right-click any <code>.toe</code> → Get Info → Open with → TDX Launcher Ultra →{" "}
                <strong>Change All…</strong>
              </p>
            ) : (
              <p className="help-tip">
                The installer registers the file association for you. If another app took it over:
                right-click a <code>.toe</code> → Open with → Choose another app → TDX Launcher Ultra
                → Always.
              </p>
            )}
            <div className="field">
              <label>If the project&rsquo;s TD build isn&rsquo;t installed</label>
              <select
                value={config.cli_fallback_version || CLI_FALLBACK_UNSET}
                onChange={(e) => void updatePref({ cli_fallback_version: e.target.value })}
              >
                <option value={CLI_FALLBACK_UNSET}>Decide the next time it happens</option>
                <option value={CLI_FALLBACK_LATEST}>
                  Open with the latest build
                  {newestMainlineKey(versionKeys)
                    ? ` (${versionNumeric(newestMainlineKey(versionKeys)!)})`
                    : ""}
                </option>
                <option value={CLI_FALLBACK_CLOSEST}>Open with the closest build</option>
                <option value={CLI_FALLBACK_ASK}>Always let me pick — no auto-launch</option>
                {mainlineVersionKeys(versionKeys)
                  .slice()
                  .reverse()
                  .map((key) => (
                    <option key={key} value={key}>
                      Always open with {versionNumeric(key)}
                    </option>
                  ))}
              </select>
              <span className="help-tip">
                Only the countdown is affected — the Launch button always lets you pick.
                Leave it undecided and the first project that needs a missing build will
                ask. A build the file wasn&rsquo;t saved with may offer to upgrade it.
              </span>
            </div>
          </>
        ),
      },
      {
        id: "look",
        title: "Make it yours",
        render: () => (
          <>
            <div className="field">
              <label>Color theme</label>
              <select
                value={THEMES.some((t) => t.id === config.theme) ? config.theme : "classic"}
                onChange={(e) => void updatePref({ theme: e.target.value })}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Project list style</label>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={(config.view_mode || "gallery") === "gallery" ? "active" : ""}
                  onClick={() => void updatePref({ view_mode: "gallery" })}
                >
                  Gallery
                </button>
                <button
                  type="button"
                  className={config.view_mode === "list" ? "active" : ""}
                  onClick={() => void updatePref({ view_mode: "list" })}
                >
                  List
                </button>
              </div>
              <span className="help-tip">
                Gallery shows project tiles with icons and hover previews; List is compact rows.
              </span>
            </div>
          </>
        ),
      },
      {
        id: "utility",
        title: "Companion Utility TOX",
        render: () => (
          <>
            <p>
              The launcher can only <em>start</em> TouchDesigner — the companion TOX is what lets
              it talk to a running session: project icons and hover previews, save from the
              launcher, drop components into the live network, the crash-watchdog heartbeat
              {isMac ? ", and recent-file sync" : ""}.
            </p>
            {bundledUtility ? (
              <>
                <div className="actions wizard-inline-actions">
                  <button
                    className="primary"
                    disabled={utilState === "busy" || utilState === "done"}
                    onClick={() => void installUtility()}
                  >
                    {utilState === "done"
                      ? "✓ Installed to Palette"
                      : utilState === "busy"
                        ? "Installing…"
                        : "Install to my Palette"}
                  </button>
                </div>
                {utilState === "error" && <p className="wizard-error">⚠ {utilError}</p>}
                {utilState === "done" ? (
                  <p className="help-tip">
                    It's in your Palette tab now — drag it into the root network of any project
                    and save.
                  </p>
                ) : (
                  <p className="help-tip">
                    Installs the bundled <code>.tox</code> into your Palette, ready to drag into
                    a project's root network.
                  </p>
                )}
                <p className="help-tip">
                  Each existing <code>.toe</code> needs that drag once. To stop repeating it, put
                  the TOX in TouchDesigner's <strong>startup file</strong> (Edit → Preferences →
                  General) — then every project you start from scratch already has it. The
                  Missing-companion card on the Sessions tab walks through the steps.
                </p>
              </>
            ) : (
              <p className="help-tip">
                This build doesn't bundle the TOX —{" "}
                <button type="button" className="linkish" onClick={onDownloadUtility}>
                  download it
                </button>{" "}
                and add it to your TD default startup file.
              </p>
            )}
          </>
        ),
      },
      {
        id: "tray",
        title: "Tray, login & hotkey",
        render: () => (
          <>
            <p>The launcher is designed to stay resident so projects are always one keystroke away — your call:</p>
            <label className="check">
              <input
                type="checkbox"
                checked={config.close_to_tray !== false}
                disabled={config.show_tray === false}
                onChange={(e) => void updatePref({ close_to_tray: e.target.checked })}
              />
              Close window to tray instead of quitting
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!autostartEnabled}
                disabled={autostartEnabled === null}
                onChange={(e) => void onToggleAutostart(e.target.checked)}
              />
              Start TDXLU when you log in{config.show_tray !== false ? " (minimized to tray)" : ""}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!config.global_hotkey_main_enabled}
                onChange={(e) => onToggleHotkeyMain(e.target.checked)}
              />
              Global hotkey — brings up the launcher from anywhere
            </label>
            <div className="field wizard-hotkey">
              <input
                type="text"
                value={hotkeyMainDraft}
                placeholder="Ctrl+Alt+D"
                disabled={!config.global_hotkey_main_enabled}
                onChange={(e) => setHotkeyMainDraft(e.target.value)}
                onBlur={() => {
                  const v = hotkeyMainDraft.trim();
                  if (v !== (config.global_hotkey_main ?? ""))
                    void updatePref({ global_hotkey_main: v });
                }}
              />
              <span className="help-tip">
                e.g. <code>Ctrl+Alt+E</code> — changing the combo takes effect after a restart.
              </span>
              {hotkeyStatusMain && !!config.global_hotkey_main_enabled && (
                <span className="wizard-error">⚠ {hotkeyStatusMain}</span>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={config.global_hotkey_enabled !== false}
                onChange={(e) => onToggleHotkey(e.target.checked)}
              />
              Second hotkey — the Quick Launch search overlay, for typing a name instead of
              browsing
            </label>
            <div className="field wizard-hotkey">
              <input
                type="text"
                value={hotkeyDraft}
                placeholder="Alt+Shift+D"
                disabled={config.global_hotkey_enabled === false}
                onChange={(e) => setHotkeyDraft(e.target.value)}
                onBlur={() => {
                  const v = hotkeyDraft.trim();
                  if (v !== (config.global_hotkey ?? "")) void updatePref({ global_hotkey: v });
                }}
              />
              {hotkeyStatus && config.global_hotkey_enabled !== false && (
                <span className="wizard-error">⚠ {hotkeyStatus}</span>
              )}
            </div>
          </>
        ),
      },
      {
        id: "extras",
        title: "Optional extras",
        render: () => (
          <>
            <p>Worth knowing about — set up now or any time in Settings:</p>
            <div className="wizard-extra">
              <div>
                <strong>Backups</strong>
                <span className="help-tip">
                  One-click sync of a project folder to a USB drive or cloud-synced folder.
                  {config.backup_root ? (
                    <>
                      {" "}
                      Root: <code>{config.backup_root}</code>
                    </>
                  ) : null}
                </span>
              </div>
              <button type="button" className="small" onClick={() => void pickBackupRoot()}>
                {config.backup_root ? "Change folder…" : "Choose folder…"}
              </button>
            </div>
            <div className="wizard-extra">
              <div>
                <strong>GitHub</strong>
                <span className="help-tip">
                  Git push/pull uses your installed Git as-is; add a token only to override HTTPS
                  auth.
                </span>
              </div>
              <button type="button" className="small" onClick={() => onOpenSettings("github")}>
                Open Settings
              </button>
            </div>
            {patreonEnabled && (
              <div className="wizard-extra">
                <div>
                  <strong>Patreon import</strong>
                  <span className="help-tip">
                    Browse .tox components from creators you support — needs your session cookie.
                  </span>
                </div>
                <button type="button" className="small" onClick={() => onOpenSettings("patreon")}>
                  Open Settings
                </button>
              </div>
            )}
            <div className="wizard-extra">
              <div>
                <strong>Crash watchdog + email alerts</strong>
                <span className="help-tip">
                  Heartbeat monitoring with auto-relaunch and SMTP alerts for installations.
                </span>
              </div>
              <button type="button" className="small" onClick={() => onOpenSettings("heartbeat")}>
                Open Settings
              </button>
            </div>
          </>
        ),
      },
      {
        id: "done",
        title: "You're set",
        render: () => (
          <>
            <p>
              That's everything. Pick a project and launch — <strong>Enter</strong> launches,{" "}
              double-click works too.
            </p>
            <p className="help-tip">
              Rerun this wizard from <strong>Help ▾ → Setup Wizard</strong>, or the tour from{" "}
              <strong>Help ▾ → Start Tour</strong>.
            </p>
          </>
        ),
      },
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, isMac, bundledUtility, utilState, utilError, hotkeyDraft, hotkeyMainDraft, autostartEnabled, hotkeyStatus, hotkeyStatusMain, patreonEnabled]);

  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;

  const goNext = () => {
    if (isLast) onClose();
    else setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  };
  const goPrev = () => setStepIdx((i) => Math.max(i - 1, 0));

  // Esc skips; arrows navigate unless the focus is in a form control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="modal-backdrop wizard-backdrop">
      <div className="modal wizard-modal" onClick={(e) => e.stopPropagation()}>
        <span className="wizard-badge">
          {isLast ? "Done" : `Setup ${stepIdx + 1} of ${steps.length}`}
        </span>
        <h2>{step.title}</h2>
        <div className="wizard-body">{step.render()}</div>
        <div className="wizard-progress">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`wizard-dot${i === stepIdx ? " wizard-dot--active" : i < stepIdx ? " wizard-dot--done" : ""}`}
            />
          ))}
        </div>
        <div className="wizard-nav">
          <button type="button" className="wizard-nav__skip" onClick={onClose}>
            Skip setup
          </button>
          <button type="button" onClick={goPrev} disabled={stepIdx === 0}>
            Back
          </button>
          <button type="button" className="primary" onClick={goNext}>
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

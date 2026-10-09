// Demo entry for the phone control surface. The real page (src/control-standalone)
// talks to the launcher's HTTP server via fetch('/api/*'); here we stub fetch
// and route those calls into the same mock backend the rest of the demo uses,
// so the touch session controls can be driven in the browser.
import { mockInvoke } from "./mock/backend";

const json = (body: unknown, ok = true) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    }),
  );

const shapeSessions = (list: unknown) => ({
  ok: true,
  sessions: (list as Record<string, unknown>[]).map((s) => ({
    path: s.path,
    name: s.display_name,
    pid: s.pid,
    alive: s.alive,
    ended_at: s.ended_at ?? null,
    started_at: s.started_at ?? null,
    source: s.source ?? "launcher",
    envoy_up: s.envoy_up ?? null,
    version_key: s.version_key,
    use_touchplayer: s.use_touchplayer,
    utility_available: s.utility_available,
    utility_version: s.utility_version,
    // Demo watchdog: the companion-bearing AuroraSet is "armed" with a live
    // pulse so the heartbeat chip renders; others aren't watched.
    watchdog:
      s.alive && s.utility_available
        ? {
            active: true,
            phase: "watching",
            last_heartbeat_secs_ago: 2 + Math.random() * 3,
            crash_count: 0,
          }
        : null,
  })),
});

const basename = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;

const realFetch = window.fetch.bind(window);

// Role comes from the hash token, like the real server's two tiers:
// open control.html#k=clientdemo for the client (authored-only) experience.
const isClient = () => window.location.hash.includes("clientdemo");
const CLIENT_ALLOWED = new Set([
  "/api/app",
  "/api/sessions",
  "/api/control/schema",
  "/api/control/values",
  "/api/control/set",
]);

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("/api/")) return realFetch(input, init);
  const path = url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
  const q = new URLSearchParams(url.split("?")[1] ?? "");
  const body = init?.body ? JSON.parse(String(init.body)) : {};

  // Mirror the server's client-tier gate: everything else is refused.
  if (isClient() && !CLIENT_ALLOWED.has(path)) {
    return json({ ok: false, error: "not available on the client link" }, false);
  }

  switch (path) {
    case "/api/app":
      return json({
        ok: true,
        name: "TDXLU",
        theme: "classic",
        perf_enabled: true,
        role: isClient() ? "client" : "author",
      });
    case "/api/sessions/perf": {
      // Steady-but-wiggling numbers so the perf line reads as live.
      const w = (base: number, amp: number) => base + (Math.random() - 0.5) * amp;
      const list = (await mockInvoke("open_projects_list_cmd", {})) as Record<
        string,
        unknown
      >[];
      const proc = Object.fromEntries(
        list
          .filter((s) => s.alive && s.pid != null)
          .map((s) => [String(s.pid), { cpu_pct: w(14, 4), mem_mb: 2210 }]),
      );
      const td = q.get("td")
        ? {
            ok: true,
            fps: w(60, 1.2),
            cook_ms: w(5.6, 1.4),
            dropped: 0,
            gpu_mem_mb: 1310,
            gpu_mem_total_mb: 12288,
          }
        : null;
      return json({ ok: true, enabled: true, proc, td });
    }
    case "/api/recents": {
      const list = (await mockInvoke("open_projects_list_cmd", {})) as Record<
        string,
        unknown
      >[];
      const running = new Set(
        list
          .filter((s) => s.alive)
          .map((s) => String(s.path).replace(/\\/g, "/").toLowerCase()),
      );
      const recents = (await mockInvoke("get_recents", { merged: true })) as Record<
        string,
        unknown
      >[];
      return json({
        ok: true,
        recents: recents
          .filter((r) => !running.has(String(r.path).replace(/\\/g, "/").toLowerCase()))
          .map((r) => ({
            path: r.path,
            name: basename(String(r.path)),
            source: r.source ?? null,
            last_opened: r.last_opened ?? null,
          })),
      });
    }
    case "/api/launch":
      return json(
        shapeSessions(
          await mockInvoke("open_project_relaunch_cmd", {
            path: body.path,
            versionKey: body.version_key ?? "TouchDesigner.2025.30060",
            useTouchplayer: false,
            killFirst: false,
            pid: null,
          }),
        ),
      );
    case "/api/sessions": {
      const full = shapeSessions(await mockInvoke("open_projects_list_cmd", {}));
      if (!isClient()) return json(full);
      return json({
        ok: true,
        sessions: full.sessions
          .filter((s) => s.alive)
          .map((s) => ({
            path: s.path,
            name: s.name,
            alive: true,
            ended_at: null,
            utility_available: s.utility_available,
            utility_version: s.utility_version,
          })),
      });
    }
    case "/api/sessions/kill":
      return json(shapeSessions(await mockInvoke("open_project_kill_cmd", { pid: body.pid })));
    case "/api/sessions/dismiss":
      return json(shapeSessions(await mockInvoke("open_project_dismiss_cmd", { path: body.path })));
    case "/api/sessions/focus":
      await mockInvoke("open_project_focus_cmd", { pid: body.pid });
      return json({ ok: true });
    case "/api/sessions/relaunch":
      return json(
        shapeSessions(
          await mockInvoke("open_project_relaunch_cmd", {
            path: body.path,
            versionKey: body.version_key,
            useTouchplayer: body.use_touchplayer,
            killFirst: body.kill_first,
            pid: body.pid,
          }),
        ),
      );
    case "/api/sessions/action":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: body.path,
          action:
            body.action === "snapshot" ? "pulse" : body.action === "record" ? "record" : "save",
          payload: null,
        }),
      );
    case "/api/control/schema":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: q.get("path"),
          action: "control_schema",
          payload: null,
        }),
      );
    case "/api/control/values":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: q.get("path"),
          action: "control_get",
          payload: null,
        }),
      );
    case "/api/control/set":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: body.path,
          action: "control_set",
          payload: { sets: body.sets },
        }),
      );
    case "/api/control/comps":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: q.get("path"),
          action: "control_comps",
          payload: q.get("parent") ? { parent: q.get("parent") } : null,
        }),
      );
    case "/api/control/add":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: body.path,
          action: "control_add",
          payload: { comp: body.comp },
        }),
      );
    case "/api/control/remove":
      return json(
        await mockInvoke("open_project_utility_cmd", {
          path: body.path,
          action: "control_remove",
          payload: { key: body.key },
        }),
      );
    default:
      return json({ ok: false, error: "unknown endpoint" }, false);
  }
}) as typeof window.fetch;

// A token so the page doesn't show the "missing token" hint.
if (!window.location.hash) window.location.hash = "#k=demotoken";

import("../src/control-standalone.tsx");

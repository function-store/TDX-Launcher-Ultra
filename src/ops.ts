/** Global tracker for long-running operations (backup runs, cloud transfers,
 *  git push/pull). Feeds the non-blocking activity chips in the corner of the
 *  window — ops keep reporting even if the panel that started them closes.
 *
 *  Determinate progress arrives from the backend on the `transfer-progress`
 *  Tauri event (per-file counts for folder backups, live byte totals from
 *  rclone for cloud); ops without events show an indeterminate spinner. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ActiveOp = {
  id: string;
  label: string;
  /** 0..1, or null = indeterminate. */
  fraction: number | null;
  detail: string;
  startedAt: number;
};

/** Payload of the backend `transfer-progress` event. */
type TransferProgress = {
  op_id: string;
  done: number;
  total: number;
  bytes: number;
  total_bytes: number;
  detail: string;
};

let ops: ActiveOp[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeOps(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getOps(): ActiveOp[] {
  return ops;
}

export function startOp(id: string, label: string) {
  ops = [
    ...ops.filter((o) => o.id !== id),
    { id, label, fraction: null, detail: "", startedAt: Date.now() },
  ];
  notify();
}

export function updateOp(
  id: string,
  patch: Partial<Pick<ActiveOp, "fraction" | "detail" | "label">>,
) {
  if (!ops.some((o) => o.id === id)) return;
  ops = ops.map((o) => (o.id === id ? { ...o, ...patch } : o));
  notify();
}

export function endOp(id: string) {
  if (!ops.some((o) => o.id === id)) return;
  ops = ops.filter((o) => o.id !== id);
  notify();
}

/** Run an async action bracketed by an activity chip. */
export async function withOp<T>(
  id: string,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  startOp(id, label);
  try {
    return await action();
  } finally {
    endOp(id);
  }
}

/** Route backend transfer-progress events into the matching active op.
 *  Call once at app start; returns the unlisten promise for cleanup. */
export function initOpsEvents(): Promise<UnlistenFn> {
  return listen<TransferProgress>("transfer-progress", (e) => {
    const p = e.payload;
    const fraction =
      p.total_bytes > 0
        ? Math.min(1, p.bytes / p.total_bytes)
        : p.total > 0
          ? Math.min(1, p.done / p.total)
          : null;
    const counts = p.total > 0 ? `${p.done}/${p.total}` : "";
    const detail = [counts, p.detail].filter(Boolean).join(" · ");
    updateOp(p.op_id, { fraction, detail });
  });
}

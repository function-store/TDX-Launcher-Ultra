// Browser-demo shim for @tauri-apps/api/event.
// Real listeners register here; the mock backend emits through emitMock.

export type UnlistenFn = () => void;

type EventCallback = (event: { event: string; id: number; payload: unknown }) => void;

const handlers = new Map<string, Set<EventCallback>>();
let nextId = 1;

export async function listen<T>(
  event: string,
  cb: (event: { event: string; id: number; payload: T }) => void,
): Promise<UnlistenFn> {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const wrapped = cb as EventCallback;
  set.add(wrapped);
  return () => {
    set!.delete(wrapped);
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  emitMock(event, payload);
}

/** Demo has one "window"; targeted emits collapse into plain emits. */
export async function emitTo(
  _target: string,
  event: string,
  payload?: unknown,
): Promise<void> {
  emitMock(event, payload);
}

/** Demo-only: fire an event into every registered listener. */
export function emitMock(event: string, payload: unknown): void {
  const set = handlers.get(event);
  if (!set) return;
  const e = { event, id: nextId++, payload };
  for (const cb of [...set]) cb(e);
}

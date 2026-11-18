export function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RequestGate {
  <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  cooldown: (extraMs: number) => void;
}

export function createRequestGate(intervalMs: number): RequestGate {
  let tail: Promise<void> = Promise.resolve();
  let nextAllowedAt = 0;

  const schedule = function schedule<T>(
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const result = tail.then(async () => {
      await waitFor(Math.max(0, nextAllowedAt - Date.now()), signal);
      nextAllowedAt = Date.now() + intervalMs;
      return task();
    });
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  } as RequestGate;

  schedule.cooldown = (extraMs: number) => {
    nextAllowedAt = Math.max(nextAllowedAt, Date.now() + extraMs);
  };

  return schedule;
}

// Separate per-service gates so slow Overpass or walking calls never block road routing.
export const withGeocodingSlot = createRequestGate(1100);
export const withRoutingSlot = createRequestGate(1100);
export const withWalkingSlot = createRequestGate(1100);
export const withOverpassSlot = createRequestGate(2200);

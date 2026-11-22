/**
 * Lekki pomiar czasu wczytywania danych.
 *
 * Wczytywanie rozkładu to kilka etapów (pobranie paczki, rozpakowanie ZIP,
 * parsowanie CSV, budowa indeksu brygad, zapis do IndexedDB). Bez pomiaru nie da
 * się stwierdzić, który z nich blokuje interfejs. Znaczniki są zerowym kosztem,
 * gdy `performance` jest niedostępny, i nie tworzą żadnych timerów.
 *
 * Wyniki czyta HUD (`?perf=1`) oraz `npm run bench:load`.
 */

export interface PerfTiming {
  name: string;
  ms: number;
  at: number;
}

const MAX_TIMINGS = 40;
const timings: PerfTiming[] = [];
const listeners = new Set<(all: PerfTiming[]) => void>();

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function recordTiming(name: string, ms: number): void {
  const at = Date.now();
  timings.push({ name, ms: Math.round(ms * 10) / 10, at });
  if (timings.length > MAX_TIMINGS) timings.shift();
  // Znaczniki trafiają też do osi czasu przeglądarki (DevTools → Performance).
  if (typeof performance !== "undefined" && typeof performance.measure === "function") {
    try {
      performance.measure(name, { start: Math.max(0, now() - ms), duration: ms });
    } catch {
      /* Starsze silniki nie znają obiektowego API performance.measure. */
    }
  }
  for (const listener of listeners) {
    try {
      listener(timings.slice());
    } catch {
      /* Pomiar nie może przewrócić wczytywania danych. */
    }
  }
}

export function measureSync<T>(name: string, task: () => T): T {
  const start = now();
  try {
    return task();
  } finally {
    recordTiming(name, now() - start);
  }
}

export async function measure<T>(name: string, task: () => Promise<T>): Promise<T> {
  const start = now();
  try {
    return await task();
  } finally {
    recordTiming(name, now() - start);
  }
}

export function getTimings(): PerfTiming[] {
  return timings.slice();
}

export function clearTimings(): void {
  timings.length = 0;
}

export function onTimings(listener: (all: PerfTiming[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Stopniowy pomiar etapów: pierwsze wywołanie zamyka etap od początku, kolejne
 * od poprzedniego wywołania. Dzięki temu jeden licznik obsługuje cały łańcuch
 * wczytywania bez przekazywania czasu między funkcjami.
 */
export function createLap(): (name: string) => void {
  let last = now();
  return (name: string) => {
    const tick = now();
    recordTiming(name, tick - last);
    last = tick;
  };
}

/**
 * Dostęp diagnostyczny: `window.__mapplanerPerf.getTimings()` pokazuje czasy
 * etapów w konsoli przeglądarki, a `scripts/bench-load.ts` czyta je w testach
 * wydajności. Zwraca kopię — nikt nie może podmienić wewnętrznego bufora.
 */
if (typeof globalThis !== "undefined") {
  (globalThis as { __mapplanerPerf?: unknown }).__mapplanerPerf = {
    getTimings,
    clearTimings,
  };
}

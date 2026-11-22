/**
 * Oddawanie sterowania przeglądarce w środku długiej pracy.
 *
 * Wczytanie rozkładu to jeden ciągły blok CPU (rozpakowanie ZIP-a, parsowanie
 * kilkudziesięciu tysięcy wierszy CSV, budowa indeksu). Wykonany w całości bez
 * przerwy tworzy „long task” — mapa i panel nie reagują na dotyk, a pierwsza
 * klatka czeka na koniec parsowania. `yieldToMain()` pozwala odmalować ekran
 * i obsłużyć wejście między porcjami wierszy.
 *
 * Kolejność wyboru mechanizmu: `scheduler.yield()` (Chrome 129+, bez opóźnienia),
 * potem `MessageChannel` (zadanie makro bez 4 ms klauzuli `setTimeout`),
 * na końcu `setTimeout(0)` dla starszych silników i testów w Node.
 */

type SchedulerLike = {
  yield?: () => Promise<void>;
};

const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;

export function yieldToMain(): Promise<void> {
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === "function") {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Ile wierszy CSV przetworzyć, zanim oddamy sterowanie (≈ 4–8 ms pracy). */
export const CSV_CHUNK_ROWS = 2_000;

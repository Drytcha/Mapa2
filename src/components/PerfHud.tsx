import { useEffect, useState } from "react";

/**
 * Opt-in licznik płynności (FPS + najdłuższa klatka + liczba węzłów DOM).
 *
 * Włącza się tylko przez `?perf=1` w adresie albo
 * `localStorage.setItem("mapplaner.perf", "1")` — normalnie nic nie renderuje
 * i nie zakłada żadnych timerów, więc nie wpływa na wydajność mapy.
 */
function isEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("perf") === "1") return true;
    return window.localStorage.getItem("mapplaner.perf") === "1";
  } catch {
    return false;
  }
}

interface PerfSample {
  fps: number;
  worstFrameMs: number;
  longFrames: number;
  nodes: number;
}

const EMPTY: PerfSample = { fps: 0, worstFrameMs: 0, longFrames: 0, nodes: 0 };

export default function PerfHud() {
  const [enabled, setEnabled] = useState(false);
  const [sample, setSample] = useState<PerfSample>(EMPTY);

  useEffect(() => {
    setEnabled(isEnabled());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let frames = 0;
    let worst = 0;
    let longFrames = 0;
    let windowStart = performance.now();
    let last = windowStart;
    let domStart = windowStart;

    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      frames += 1;
      // Klatki dłuższe niż 34 ms (~30 fps) to odczuwalne przycięcie.
      if (delta > 34) {
        longFrames += 1;
        worst = Math.max(worst, delta);
      }
      if (now - windowStart >= 1_000) {
        const seconds = (now - windowStart) / 1_000;
        const nodes =
          now - domStart >= 1_000 ? document.querySelectorAll("*").length : null;
        if (nodes !== null) domStart = now;
        setSample((current) => ({
          fps: Math.round(frames / seconds),
          worstFrameMs: Math.round(worst),
          longFrames,
          nodes: nodes ?? current.nodes,
        }));
        frames = 0;
        worst = 0;
        longFrames = 0;
        windowStart = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);

  if (!enabled) return null;

  const tone =
    sample.fps >= 55
      ? "bg-[#0d4f3b] text-[#d7f36e]"
      : sample.fps >= 35
        ? "bg-[#8a5a12] text-[#fff7e6]"
        : "bg-[#8f2d1c] text-[#ffe9e3]";

  return (
    <div
      data-testid="perf-hud"
      className={`pointer-events-none fixed bottom-2 left-2 z-[900] select-none rounded-md px-2 py-1 font-mono text-[10px] font-bold leading-tight shadow-lg ${tone}`}
    >
      <div>{sample.fps} fps</div>
      <div>
        klatka max {sample.worstFrameMs} ms · cięcia {sample.longFrames}/s
      </div>
      <div>DOM {sample.nodes}</div>
    </div>
  );
}

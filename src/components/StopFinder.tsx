import { useMemo, useState } from "react";
import { Bus, Search, X } from "lucide-react";
import { filterStops, stopDisplayName } from "@/lib/busStops";
import { filterLinesForRole } from "@/lib/core/text";
import type { BusStop } from "@/lib/types";

/** A direct way to find a stop even when the map is elsewhere or its layer is hidden. */
export default function StopFinder({
  stops,
  isPlanner,
  onSelect,
}: {
  stops: BusStop[];
  isPlanner: boolean;
  onSelect: (stop: BusStop) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchableStops = useMemo(
    () => isPlanner ? stops : stops.map((stop) => ({ ...stop, lines: filterLinesForRole(stop.lines, false) })),
    [stops, isPlanner]
  );
  const matches = useMemo(
    () => [...filterStops(searchableStops, query)].sort((a, b) =>
      stopDisplayName(a).localeCompare(stopDisplayName(b), "pl", { numeric: true })
    ),
    [searchableStops, query]
  );
  const shown = matches.slice(0, 30);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="stop-finder"
        onClick={() => setOpen((current) => !current)}
        className="pointer-events-auto flex min-h-8 items-center gap-1.5 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-[9.5px] font-extrabold text-ink shadow-[0_10px_28px_rgba(13,42,28,0.35)] transition-colors hover:bg-raised sm:min-h-9 sm:px-3 sm:py-2 sm:text-[10px]"
      >
        <Bus className="h-3.5 w-3.5 text-brand-ink" strokeWidth={2.4} />
        Przystanki
      </button>
      {open && (
        <section
          id="stop-finder"
          role="dialog"
          aria-label="Znajdź przystanek"
          className="pointer-events-auto absolute bottom-[calc(100%+8px)] left-0 flex max-h-[min(440px,60dvh)] w-[min(340px,calc(100vw-24px))] flex-col rounded-xl border border-line bg-surface p-2 shadow-[0_16px_44px_rgba(0,0,0,0.28)]"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <h2 className="text-[11px] font-extrabold text-ink">Znajdź przystanek</h2>
            <button
              type="button"
              aria-label="Zamknij wyszukiwarkę przystanków"
              onClick={() => setOpen(false)}
              className="grid h-7 w-7 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-2">
            <Search className="h-4 w-4 shrink-0 text-mute" aria-hidden="true" />
            <input
              autoFocus
              type="search"
              aria-label="Szukaj przystanku"
              placeholder="Nazwa przystanku lub linia"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 min-w-0 w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-mute"
            />
          </label>
          <p className="px-1 py-1.5 text-[9px] text-mute" role="status">
            {matches.length
              ? `Przystanki: ${matches.length}${matches.length > shown.length ? ` · pierwsze ${shown.length}` : ""}`
              : "Brak przystanków pasujących do wyszukiwania."}
          </p>
          <ul className="scroll-area min-h-0 overflow-y-auto">
            {shown.map((stop) => (
              <li key={stop.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(stop);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-raised focus-visible:bg-raised"
                >
                  <span className="text-[11px] font-bold leading-snug text-ink">{stopDisplayName(stop)}</span>
                  <span className="text-[9px] text-mute">
                    {stop.lines.length ? `Linie: ${stop.lines.join(", ")} · ` : ""}
                    {stop.lat.toFixed(5)}, {stop.lon.toFixed(5)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import {
  ArrowLeft,
  BusFront,
  ChevronDown,
  ChevronUp,
  ListOrdered,
  Maximize2,
  X,
} from "lucide-react";
import { formatWarsawClock } from "@/lib/core/time";
import type { CoursePreview } from "@/lib/engine/gtfsStore";
import { OPERATOR_STYLES } from "@/lib/transit";

interface Props {
  course: CoursePreview;
  onClose: () => void;
  onFit: () => void;
  onBack: () => void;
  onSelectStop: (lat: number, lon: number) => void;
}

export default function CoursePreviewCard({
  course,
  onClose,
  onFit,
  onBack,
  onSelectStop,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const operator = OPERATOR_STYLES[course.operatorKey];
  const dateLabel = `${course.dateId.slice(6, 8)}.${course.dateId.slice(4, 6)}.${course.dateId.slice(0, 4)}`;
  const distance =
    course.distanceMeters > 0
      ? `${(course.distanceMeters / 1000).toLocaleString("pl-PL", {
          maximumFractionDigits: 1,
        })} km`
      : null;

  return (
    <section
      aria-label={`Przebieg kursu linii ${course.routeShort}`}
      data-testid="course-preview-card"
      className="pointer-events-auto flex max-h-[min(510px,calc(100dvh-230px))] w-[336px] max-w-full flex-col overflow-hidden rounded-[14px] border border-line bg-surface/96 shadow-[0_16px_44px_rgba(13,42,28,0.22)] backdrop-blur-xl animate-rise-in dark:bg-surface/93"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-brand-soft/70 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-on-brand">
          <BusFront className="h-3.5 w-3.5" strokeWidth={2.3} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-extrabold text-ink">Przebieg kursu</h3>
          <p className="text-[7.5px] font-bold uppercase tracking-[0.11em] text-brand-ink/75">
            Rozkład GTFS · {dateLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij podgląd kursu"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-surface hover:text-ink"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.3} />
        </button>
      </div>

      <div className="shrink-0 border-b border-line/60 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span
            className="metric grid h-7 min-w-[30px] shrink-0 place-items-center rounded-md px-1.5 text-[11px] font-extrabold"
            style={{ backgroundColor: course.color, color: course.textColor }}
          >
            {course.routeShort}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10px] font-extrabold text-ink" title={course.headsign}>
              {course.headsign}
            </p>
            <p className="truncate text-[8px] font-semibold text-mute">
              {course.stops[0].name} → {course.stops[course.stops.length - 1].name}
            </p>
          </div>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[8px] font-extrabold"
            title={course.operatorName}
            style={{ backgroundColor: operator.bg, color: operator.fg }}
          >
            {operator.label}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[8.5px] font-bold text-ink-soft">
          <span className="metric rounded-md border border-line bg-raised px-1.5 py-1 text-[10px] font-extrabold text-ink">
            {formatWarsawClock(course.startMs)} → {formatWarsawClock(course.endMs)}
          </span>
          <span>·</span>
          <span>{course.stops.length} przystanków</span>
          {distance && <span>· {distance}</span>}
          {course.dutyCode && (
            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[8px] font-bold text-brand-ink">
              Brygada {course.dutyCode}
            </span>
          )}
        </div>
        {course.approximate && (
          <p className="mt-1 text-[8px] leading-snug text-warning">
            Przebieg orientacyjny wyznaczony według kolejnych przystanków — brak geometrii GTFS.
          </p>
        )}
        {course.unresolvedGaps > 0 && (
          <p className="mt-1 text-[8px] leading-snug text-warning">
            Nie udało się wyznaczyć {course.unresolvedGaps} odcinków po drogach. Pominięto je na mapie; spróbuj ponownie.
          </p>
        )}

      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
        <span className="inline-flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-[0.12em] text-mute">
          <ListOrdered className="h-3 w-3" /> Przystanki po kolei
        </span>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="inline-flex items-center gap-1 text-[8px] font-bold text-brand-ink hover:underline"
        >
          {collapsed ? "Rozwiń" : "Zwiń"}
          {collapsed ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronUp className="h-3 w-3" />
          )}
        </button>
      </div>

      {!collapsed && (
        <ol
          aria-label="Lista przystanków kursu"
          className="scroll-area min-h-0 flex-1 overflow-y-auto border-t border-line/60 px-3 py-1"
        >
          {course.stops.map((stop, index) => {
            const isStart = index === 0;
            const isEnd = index === course.stops.length - 1;
            const time = formatWarsawClock(isEnd ? stop.arrivalMs : stop.departureMs);
            return (
              <li key={`${stop.sequence}-${stop.id}-${index}`} className="relative">
                {/* Ciągła oś trasy: jeden element na odcinek, sięga środka kolejnego przystanku. */}
                {index < course.stops.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-3 left-[11px] top-3 w-0.5 rounded-full"
                    style={{ backgroundColor: course.color, opacity: 0.38 }}
                  />
                )}
                <button
                  type="button"
                  data-testid="course-preview-stop"
                  onClick={() => onSelectStop(stop.lat, stop.lon)}
                  title={`Pokaż na mapie: ${stop.name} (${time})`}
                  className="group flex w-full items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-raised focus-visible:bg-raised focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <span className="relative flex w-4 shrink-0 justify-center self-stretch pt-0.5">
                    <span
                      className="relative z-10 grid h-3 w-3 shrink-0 place-items-center rounded-full border-2 border-white text-[6px] font-extrabold text-white shadow-sm"
                      style={{
                        backgroundColor: isStart
                          ? "#0891b2"
                          : isEnd
                            ? "#e11d48"
                            : course.color,
                      }}
                    />
                  </span>
                  <span className="metric w-[37px] shrink-0 pt-px text-[9px] font-extrabold text-ink-soft">
                    {time}
                    {stop.afterMidnight && (
                      <span className="ml-0.5 text-[7px] font-semibold text-mute" title="Następny dzień">
                        +1
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-[9px] font-semibold leading-snug text-ink group-hover:text-brand-ink">
                    {stop.name}
                  </span>
                  {(isStart || isEnd) && (
                    <span
                      className="shrink-0 rounded px-1 py-0.5 text-[7px] font-extrabold uppercase"
                      style={{
                        backgroundColor: isStart ? "#0891b220" : "#e11d4820",
                        color: isStart ? "#0891b2" : "#e11d48",
                      }}
                    >
                      {isStart ? "Start" : "Koniec"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex shrink-0 items-center gap-1.5 border-t border-line/70 bg-raised/60 px-3 py-2">
        <button
          type="button"
          onClick={onFit}
          className="flex h-7 flex-1 items-center justify-center gap-1 rounded-lg bg-brand px-2 text-[8.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90"
        >
          <Maximize2 className="h-3 w-3" strokeWidth={2.4} />
          Pokaż całą trasę
        </button>
        <button
          type="button"
          onClick={onBack}
          title="Wróć do listy kursów tej brygady"
          className="flex h-7 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2 text-[8.5px] font-bold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
        >
          <ArrowLeft className="h-3 w-3" /> Kursówki
        </button>
      </div>
    </section>
  );
}

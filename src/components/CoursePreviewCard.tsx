"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  BusFront,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  Maximize2,
  X,
} from "lucide-react";
import { formatWarsawClock } from "@/lib/core/time";
import type { CoursePreview } from "@/lib/engine/gtfsStore";
import { legendCodeForTrip, legendLineLabel, legendText } from "@/lib/lineLegend";
import { OPERATOR_STYLES } from "@/lib/transit";

interface Props {
  course: CoursePreview;
  onClose: () => void;
  onFit: () => void;
  onBack: () => void;
  onSelectStop: (lat: number, lon: number) => void;
  onDrawerOpenChange?: (open: boolean) => void;
}

function isDesktopViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(min-width: 768px)").matches;
}

export default function CoursePreviewCard({
  course,
  onClose,
  onFit,
  onBack,
  onSelectStop,
  onDrawerOpenChange,
}: Props) {
  // Na telefonie prawy sidebar startuje zwinięty, aby po kliknięciu kursu
  // od razu było widać całą trasę na mapie — użytkownik może go w każdej
  // chwili wysunąć z prawej krawędzi ekranu.
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => isDesktopViewport());

  useEffect(() => {
    onDrawerOpenChange?.(drawerOpen);
  }, [drawerOpen, onDrawerOpenChange]);

  useEffect(() => {
    return () => {
      onDrawerOpenChange?.(false);
    };
  }, [onDrawerOpenChange]);

  const operator = OPERATOR_STYLES[course.operatorKey];
  const dateLabel = `${course.dateId.slice(6, 8)}.${course.dateId.slice(4, 6)}.${course.dateId.slice(0, 4)}`;
  // Oficjalna legenda linii: litera wariantu wynika z kierunku i trasy kursu.
  // Kierunkiem jest rzeczywisty koniec kursu — `headsign` bywa nieaktualny.
  const courseStops = course.stops.map((stop) => stop.name);
  const variantCode = legendCodeForTrip(course.routeShort, {
    terminus: courseStops.at(-1),
    destination: course.headsign,
    stops: courseStops,
  });
  const variantText = legendText(course.routeShort, variantCode);

  const collapseOnMobile = () => {
    if (!isDesktopViewport()) {
      setDrawerOpen(false);
    }
  };

  return (
    <div
      data-testid="course-preview-sidebar-root"
      className="pointer-events-none absolute inset-0 z-[630] overflow-hidden"
    >
      {/* Delikatna strefa kliknięcia na telefonie: stuknięcie w mapę z lewej zwija prawy sidebar */}
      {drawerOpen && (
        <button
          type="button"
          aria-label="Zwiń panel przebiegu kursu i pokaż mapę"
          onClick={() => setDrawerOpen(false)}
          className="pointer-events-auto absolute inset-0 bg-black/25 transition-opacity md:hidden"
        />
      )}

      {/* Uchwyt po prawej krawędzi do wysuwania panelu (widoczny gdy sidebar jest zwinięty) */}
      {!drawerOpen && (
        <div
          data-testid="course-drawer-tab"
          className="pointer-events-auto absolute right-0 top-[56%] flex -translate-y-1/2 flex-col items-stretch overflow-hidden rounded-l-2xl border-y border-l border-line bg-surface/96 shadow-[0_12px_32px_rgba(13,42,28,0.28)] dark:bg-surface/95"
        >
          <button
            type="button"
            data-testid="course-drawer-toggle"
            aria-expanded={false}
            aria-label={`Rozsuń szczegóły kursu linii ${course.routeShort}`}
            onClick={() => setDrawerOpen(true)}
            className="flex flex-col items-center gap-1 px-2 py-2.5 text-center transition-colors hover:bg-raised active:bg-raised"
          >
            <ChevronLeft className="h-4 w-4 text-brand-ink" strokeWidth={2.5} />
            <span
              className="metric grid h-6 min-w-[26px] place-items-center rounded-md px-1 text-[10px] font-extrabold"
              style={{ backgroundColor: course.color, color: course.textColor }}
            >
              {course.routeShort}
            </span>
            <span className="text-[8px] font-extrabold uppercase tracking-[0.06em] text-ink">
              Kurs
            </span>
            <span className="metric text-[8.5px] font-bold text-mute">
              {formatWarsawClock(course.startMs)}
            </span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij podgląd kursu"
            title="Zamknij podgląd kursu"
            className="grid h-7 place-items-center border-t border-line/70 bg-raised/60 text-mute transition-colors hover:bg-warning-soft hover:text-warning"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.3} />
          </button>
        </div>
      )}

      {/* Rozsuwany prawy sidebar z przebiegiem kursu i listą przystanków */}
      <aside
        aria-label={`Przebieg kursu linii ${course.routeShort}`}
        aria-hidden={!drawerOpen}
        data-testid="course-preview-card"
        data-open={drawerOpen ? "true" : "false"}
        className={`pointer-events-auto absolute inset-y-0 right-0 flex w-[min(336px,86vw)] flex-col overflow-hidden border-l border-line bg-surface/98 shadow-[-12px_0_36px_rgba(13,42,28,0.24)] transition-transform duration-200 ease-out md:bottom-3 md:right-[54px] md:top-[52px] md:w-[336px] md:rounded-[14px] md:border md:shadow-[0_16px_44px_rgba(13,42,28,0.22)] dark:bg-surface/96 ${
          drawerOpen
            ? "translate-x-0"
            : "pointer-events-none translate-x-[calc(100%+72px)]"
        }`}
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
            data-testid="course-drawer-collapse"
            onClick={() => setDrawerOpen(false)}
            aria-label="Zwiń panel kursu do prawej krawędzi"
            title="Zwiń panel i pokaż mapę"
            className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface px-2 text-[8.5px] font-extrabold text-brand-ink transition-colors hover:bg-raised"
          >
            Mapa
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.4} />
          </button>
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
                {variantCode && (
                  <span
                    className="ml-1 rounded bg-brand-soft px-1 py-0.5 font-mono text-[8px] font-extrabold text-brand-ink"
                    title={variantText}
                  >
                    {legendLineLabel(course.routeShort, variantCode)}
                  </span>
                )}
              </p>
              {variantText && (
                <p className="truncate text-[8px] font-semibold text-brand-ink/80" title={variantText}>
                  {variantText}
                </p>
              )}
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
              {course.unresolvedGaps} odcinków poprowadzono w linii prostej — nie udało się wyznaczyć ich po drogach. Trasa jest kompletna.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
          <span className="inline-flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-[0.12em] text-mute">
            <ListOrdered className="h-3 w-3" /> Przystanki po kolei
          </span>
          <span className="text-[7.5px] font-semibold text-mute md:hidden">
            Kliknij przystanek, aby pokazać na mapie
          </span>
        </div>

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
                  onClick={() => {
                    onSelectStop(stop.lat, stop.lon);
                    collapseOnMobile();
                  }}
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

        <div className="flex shrink-0 items-center gap-1.5 border-t border-line/70 bg-raised/60 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => {
              onFit();
              collapseOnMobile();
            }}
            className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-brand px-2 text-[8.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90"
          >
            <Maximize2 className="h-3 w-3" strokeWidth={2.4} />
            Pokaż całą trasę
          </button>
          <button
            type="button"
            onClick={onBack}
            title="Wróć do listy kursów tej brygady"
            className="flex h-8 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[8.5px] font-bold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
          >
            <ArrowLeft className="h-3 w-3" /> Kursówki
          </button>
        </div>
      </aside>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BusFront,
  ChevronLeft,
  ChevronRight,
  Clock,
  ListOrdered,
  MapPin,
  Maximize2,
  Undo2,
  X,
} from "lucide-react";
import { formatWarsawClock } from "@/lib/core/time";
import type { CoursePreview } from "@/lib/engine/gtfsStore";
import { courseStopTarget } from "@/lib/courseRoute";
import { formatDistanceCompact } from "@/lib/geo";
import { legendCodeForTrip, legendLineLabel, legendText } from "@/lib/lineLegend";
import { OPERATOR_STYLES } from "@/lib/transit";
import { cn } from "@/utils/cn";

interface Props {
  course: CoursePreview;
  /** Osadzony w lewym sidebarze zamiast osobnego prawego panelu. */
  embedded?: boolean;
  onClose: () => void;
  onFit: () => void;
  onBack: () => void;
  onSelectStop: (lat: number, lon: number) => void;
  onDrawerOpenChange?: (open: boolean) => void;
  /** Przystanek docelowy podróżnego; `null` = cała trasa kursu. */
  targetStopIndex?: number | null;
  /** Klik w przystanek: pokaż trasę do niego (albo wróć do całej trasy). */
  onSelectRouteTarget?: (index: number | null) => void;
  /** Przewijanie do wybranego przystanku poza panelem (np. „jedź do tego przystanku”). */
  focusStopIndex?: number | null;
  /** Licznik wymusza ponowne przewinięcie do tego samego przystanku. */
  focusNonce?: number;
}

const minutesLabel = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

function isDesktopViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(min-width: 768px)").matches;
}

export default function CoursePreviewCard({
  course,
  embedded = false,
  onClose,
  onFit,
  onBack,
  onSelectStop,
  onDrawerOpenChange,
  targetStopIndex = null,
  onSelectRouteTarget,
  focusStopIndex = null,
  focusNonce = 0,
}: Props) {
  // Na telefonie prawy sidebar startuje zwinięty, aby po kliknięciu kursu
  // od razu było widać całą trasę na mapie — użytkownik może go w każdej
  // chwili wysunąć z prawej krawędzi ekranu.
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() =>
    embedded ? true : isDesktopViewport(),
  );

  // Callback trzymamy w ref, żeby zmiana funkcji w rodzicu nie wyglądała jak
  // zamknięcie panelu: cleanup zgłaszałby „zwinięty” przy każdym re-renderze
  // i dopasowanie trasy traciłoby miejsce na (widoczny!) panel.
  const openChangeRef = useRef(onDrawerOpenChange);
  openChangeRef.current = onDrawerOpenChange;
  useEffect(() => {
    openChangeRef.current?.(drawerOpen);
  }, [drawerOpen]);

  useEffect(() => {
    return () => {
      openChangeRef.current?.(false);
    };
  }, []);

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

  // Trasa do wybranego przystanku: podróżny może wysiąść wcześniej niż na pętli.
  const targetIndex =
    targetStopIndex != null && targetStopIndex >= 0 && targetStopIndex < course.stops.length
      ? targetStopIndex
      : null;
  const target = useMemo(
    () => (targetIndex == null ? null : courseStopTarget(course, targetIndex)),
    [course, targetIndex],
  );
  const targetStop = targetIndex == null ? null : course.stops[targetIndex];
  const selectTarget = (index: number | null) => {
    onSelectRouteTarget?.(index);
  };
  // Po wyborze przystanku na mapie panel podjeżdża do jego wiersza — inaczej
  // użytkownik nie widzi, że trasa się zmieniła.
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (focusStopIndex == null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-stop-index="${focusStopIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [focusStopIndex, focusNonce]);

  const collapseOnMobile = () => {
    if (!isDesktopViewport()) {
      setDrawerOpen(false);
    }
  };

  const jumpToStop = (lat: number, lon: number) => {
    // Na telefonie panel zasłania mapę — najpierw go zwiń, potem pokaż przystanek.
    onSelectStop(lat, lon);
    collapseOnMobile();
  };

  return (
    <div
      data-testid="course-preview-sidebar-root"
      className={cn(
        embedded
          ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface"
          : "pointer-events-none absolute inset-0 z-[560] overflow-hidden",
      )}
    >
      {/* Delikatna strefa kliknięcia na telefonie: stuknięcie w mapę z lewej zwija
          prawy sidebar. Przyciemniamy tylko wąski pas obok panelu — reszta mapy
          (z trasą) zostaje widoczna i przesuwalna. */}
      {!embedded && drawerOpen && (
        <button
          type="button"
          aria-label="Zwiń panel przebiegu kursu i pokaż mapę"
          onClick={() => setDrawerOpen(false)}
          className="pointer-events-auto absolute inset-y-0 left-0 w-[calc(100%-min(300px,84vw))] bg-black/15 transition-opacity md:hidden"
        />
      )}

      {/* Uchwyt po prawej krawędzi do wysuwania panelu (widoczny gdy sidebar jest zwinięty) */}
      {!embedded && !drawerOpen && (
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

      {/* Panel przebiegu kursu i lista przystanków */}
      <aside
        aria-label={`Przebieg kursu linii ${course.routeShort}`}
        aria-hidden={!embedded && !drawerOpen}
        data-testid="course-preview-card"
        data-open={embedded || drawerOpen ? "true" : "false"}
        className={cn(
          embedded
            ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface"
            : `pointer-events-auto absolute inset-y-0 right-0 flex w-[min(300px,84vw)] flex-col overflow-hidden border-l border-line bg-surface/98 shadow-[-12px_0_36px_rgba(13,42,28,0.24)] transition-transform duration-200 ease-out md:bottom-3 md:right-[54px] md:top-[52px] md:w-[300px] md:rounded-[14px] md:border md:shadow-[0_16px_44px_rgba(13,42,28,0.22)] dark:bg-surface/96 ${
                drawerOpen
                  ? "translate-x-0"
                  : "pointer-events-none translate-x-[calc(100%+72px)]"
              }`,
        )}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line/50 px-3 py-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-on-brand">
            <BusFront className="h-3.5 w-3.5" strokeWidth={2.3} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[12px] font-bold text-ink">Przebieg kursu</h3>
            <p className="text-[10px] text-mute">
              Rozkład GTFS · {dateLabel}
            </p>
          </div>
          {!embedded && (
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
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij podgląd kursu"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-soft hover:text-ink"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.3} />
          </button>
        </div>

        <div className="shrink-0 border-b border-line/60 px-2.5 py-2">
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
          {onSelectRouteTarget && target && targetStop && (
            <div
              data-testid="course-target-summary"
              className="mt-2 rounded-lg border border-[#7c3aed]/40 bg-[#7c3aed]/8 px-2 py-1.5"
            >
              <div className="flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-[0.1em] text-[#6d28d9] dark:text-[#c4b5fd]">
                <MapPin className="h-2.5 w-2.5" strokeWidth={2.6} />
                Trasa do przystanku
              </div>
              <p className="mt-0.5 truncate text-[9.5px] font-extrabold text-ink" title={targetStop.name}>
                {targetStop.name}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8.5px] font-bold text-ink-soft">
                <span className="metric rounded border border-[#7c3aed]/30 bg-surface px-1 py-0.5 text-[9px] font-extrabold text-ink">
                  {formatWarsawClock(target.departMs)} → {formatWarsawClock(target.arriveMs)}
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" strokeWidth={2.4} />
                  {minutesLabel(target.rideMs)} jazdy
                </span>
                <span>{formatDistanceCompact(target.meters)}</span>
              </div>
              <p className="mt-1 text-[7.5px] font-semibold leading-snug text-mute">
                Na mapie widać dojazd do tego przystanku — reszta kursu jest wygaszona.
              </p>
            </div>
          )}
          {targetIndex != null && !target && onSelectRouteTarget && (
            <p
              data-testid="course-target-missing"
              className="mt-2 rounded-lg border border-warning/40 bg-warning-soft/70 px-2 py-1.5 text-[8px] font-semibold leading-snug text-warning"
            >
              Nie udało się przyciąć trasy do tego przystanku — pokazuję cały przebieg kursu.
            </p>
          )}
          {!target && onSelectRouteTarget && (
            <p className="mt-2 rounded-lg border border-dashed border-line bg-raised/60 px-2 py-1.5 text-[8px] font-semibold leading-snug text-mute">
              Chcesz wysiąść wcześniej? Kliknij przystanek na liście, aby zobaczyć trasę do niego.
            </p>
          )}
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

        <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1.5">
          <span className="inline-flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-[0.12em] text-mute">
            <ListOrdered className="h-3 w-3" /> Przystanki po kolei
          </span>
          <span className="text-[7.5px] font-semibold text-mute">
            Kliknij przystanek, aby zobaczyć trasę do niego
          </span>
        </div>

        <ol
          ref={listRef}
          aria-label="Lista przystanków kursu"
          className="scroll-area min-h-0 flex-1 overflow-y-auto border-t border-line/60 px-2 py-1"
        >
          {course.stops.map((stop, index) => {
            const isStart = index === 0;
            const isEnd = index === course.stops.length - 1;
            const isTarget = targetIndex === index;
            const beyondTarget = targetIndex != null && index > targetIndex;
            const time = formatWarsawClock(isEnd ? stop.arrivalMs : stop.departureMs);
            return (
              <li
                key={`${stop.sequence}-${stop.id}-${index}`}
                data-stop-index={index}
                className="relative"
              >
                {/* Ciągła oś trasy: jeden element na odcinek, sięga środka kolejnego przystanku. */}
                {index < course.stops.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-3 left-[11px] top-3 w-0.5 rounded-full"
                    style={{
                      backgroundColor: beyondTarget ? "#94a3b8" : course.color,
                      opacity: beyondTarget ? 0.22 : 0.38,
                    }}
                  />
                )}
                <div
                  className={cn(
                    "group flex w-full items-start gap-1.5 rounded-md px-1 py-1 transition-colors",
                    isTarget
                      ? "bg-[#7c3aed]/10 ring-1 ring-inset ring-[#7c3aed]/40"
                      : "hover:bg-raised focus-within:bg-raised",
                    beyondTarget && "opacity-55",
                  )}
                >
                  <button
                    type="button"
                    data-testid="course-preview-stop"
                    data-target={isTarget ? "true" : undefined}
                    aria-pressed={onSelectRouteTarget ? isTarget : undefined}
                    onClick={() => {
                      // Podróżny: klik = trasa do tego przystanku (nie tylko do końca).
                      if (onSelectRouteTarget) {
                        selectTarget(isTarget ? null : index);
                        collapseOnMobile();
                        return;
                      }
                      jumpToStop(stop.lat, stop.lon);
                    }}
                    title={
                      onSelectRouteTarget
                        ? isTarget
                          ? `Pokaż całą trasę kursu (teraz: dojazd do ${stop.name})`
                          : `Zobacz trasę kursu do przystanku: ${stop.name} (${time})`
                        : `Pokaż na mapie: ${stop.name} (${time})`
                    }
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-0.5 text-left focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    <span className="relative flex w-4 shrink-0 justify-center self-stretch pt-0.5">
                      <span
                        className="relative z-10 grid shrink-0 place-items-center rounded-full border-2 border-white text-[6px] font-extrabold text-white shadow-sm"
                        style={{
                          width: isTarget ? 14 : 12,
                          height: isTarget ? 14 : 12,
                          backgroundColor: isTarget
                            ? "#7c3aed"
                            : isStart
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
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-[9px] font-semibold leading-snug",
                        isTarget ? "font-extrabold text-ink" : "text-ink group-hover:text-brand-ink",
                      )}
                    >
                      {stop.name}
                    </span>
                    {isTarget ? (
                      <span className="shrink-0 rounded bg-[#7c3aed] px-1 py-0.5 text-[7px] font-extrabold uppercase text-white">
                        Tu wysiadasz
                      </span>
                    ) : (isStart || isEnd) ? (
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[7px] font-extrabold uppercase"
                        style={{
                          backgroundColor: isStart ? "#0891b220" : "#e11d4820",
                          color: isStart ? "#0891b2" : "#e11d48",
                        }}
                      >
                        {isStart ? "Start" : "Koniec"}
                      </span>
                    ) : null}
                  </button>
                  {onSelectRouteTarget && (
                    <button
                      type="button"
                      data-testid="course-preview-stop-center"
                      onClick={() => jumpToStop(stop.lat, stop.lon)}
                      title={`Pokaż na mapie: ${stop.name}`}
                      aria-label={`Pokaż na mapie przystanek ${stop.name}`}
                      className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-soft hover:text-brand-ink"
                    >
                      <MapPin className="h-2.5 w-2.5" strokeWidth={2.4} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex shrink-0 items-center gap-1.5 border-t border-line/70 bg-raised/60 px-2.5 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {target ? (
            <button
              type="button"
              data-testid="course-target-clear"
              onClick={() => selectTarget(null)}
              title="Wróć do przebiegu całego kursu"
              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2 text-[8.5px] font-extrabold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
            >
              <Undo2 className="h-3 w-3" strokeWidth={2.4} />
              Cała trasa
            </button>
          ) : null}
          <button
            type="button"
            data-testid="course-target-fit"
            onClick={() => {
              onFit();
              collapseOnMobile();
            }}
            className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-brand px-2 text-[8.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90"
          >
            <Maximize2 className="h-3 w-3" strokeWidth={2.4} />
            {target ? "Dopasuj" : "Pokaż całą trasę"}
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

import { useState } from "react";
import { Loader2, LocateFixed, LocateOff, Navigation, X } from "lucide-react";
import { useSharedClock } from "@/lib/core/runtimeHub";
import { formatDistanceCompact } from "@/lib/geo";
import { compassLabel, type LocationStatus, type UserLocation } from "@/lib/useUserLocation";
import { cn } from "@/utils/cn";

interface Props {
  status: LocationStatus;
  location: UserLocation | null;
  following: boolean;
  onCenter: () => void;
  onRetry: () => void;
}

const STALE_AFTER_S = 15;
const WEAK_ACCURACY_M = 100;

const formatSpeed = (kmh: number) =>
  (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))).replace(".", ",");
const formatKm = formatDistanceCompact;

/** Karta z danymi GPS użytkownika: prędkość, kierunek, dokładność i przebyty dystans. */
export default function UserLocationHud({
  status,
  location,
  following,
  onCenter,
  onRetry,
}: Props) {
  const now = useSharedClock(1_000, status === "active");
  const [dismissed, setDismissed] = useState(false);

  if (status === "idle") return null;

  if (status === "requesting" && !location) {
    return (
      <div
        role="status"
        data-testid="user-location-hud"
        className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-line/80 bg-surface/94 px-2.5 py-1.5 text-[9px] font-bold text-ink-soft shadow-[0_8px_24px_rgba(13,42,28,0.14)] "
      >
        <Loader2 className="h-3 w-3 animate-spin text-brand-ink" />
        Szukam lokalizacji GPS… zezwól na dostęp w przeglądarce
      </div>
    );
  }

  if (status === "denied" || status === "unavailable") {
    if (dismissed) return null;
    return (
      <div
        role="alert"
        data-testid="user-location-hud"
        className="pointer-events-auto flex max-w-[270px] items-start gap-1.5 rounded-xl border border-warning/40 bg-warning-soft/95 px-2.5 py-1.5 text-[9px] leading-snug text-warning shadow-[0_8px_24px_rgba(13,42,28,0.14)] "
      >
        <LocateOff className="mt-px h-3 w-3 shrink-0" />
        <div className="min-w-0 flex-1">
          {status === "denied"
            ? "Lokalizacja zablokowana. Zezwól na nią w ustawieniach strony w przeglądarce."
            : "Ta przeglądarka nie udostępnia lokalizacji GPS."}
          {status === "denied" && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-1 font-extrabold underline"
            >
              Spróbuj ponownie
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Ukryj komunikat o lokalizacji"
          className="grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-warning/15"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
    );
  }

  if (!location) return null;

  const ageS = Math.max(0, Math.round((now - location.timestamp) / 1000));
  const stale = ageS > STALE_AFTER_S;
  const weak = location.accuracy > WEAK_ACCURACY_M;
  const moving = location.speedKmh !== null && location.speedKmh >= 1;

  return (
    <section
      aria-label="Twoja lokalizacja i prędkość"
      data-testid="user-location-hud"
      className="pointer-events-auto w-[212px] max-w-[calc(100vw-76px)] rounded-xl border border-line/80 bg-surface/94 px-2.5 py-1.5 shadow-[0_8px_24px_rgba(13,42,28,0.14)] "
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[7px] font-extrabold uppercase tracking-[0.14em] text-mute">
            Twoja prędkość
          </p>
          <p className="flex items-baseline gap-1 leading-none">
            <span
              className="metric text-[22px] font-extrabold text-ink"
              data-testid="user-speed"
            >
              {location.speedKmh === null ? "—" : formatSpeed(location.speedKmh)}
            </span>
            <span className="text-[9px] font-bold text-mute">km/h</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onCenter}
          aria-label="Wycentruj na mojej lokalizacji"
          title="Wycentruj na mojej lokalizacji"
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
            following
              ? "bg-brand text-on-brand"
              : "bg-soft text-ink-soft hover:text-ink",
          )}
        >
          <LocateFixed className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
      </div>

      <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[8px]">
        <div className="min-w-0">
          <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.1em] text-mute">
            Kierunek
          </dt>
          <dd className="metric flex items-center gap-1 font-bold text-ink" data-testid="user-heading">
            {location.heading !== null ? (
              <>
                <Navigation
                  className="h-2.5 w-2.5 shrink-0 text-brand-ink"
                  style={{ transform: `rotate(${location.heading - 45}deg)` }}
                />
                {compassLabel(location.heading)} {Math.round(location.heading)}°
              </>
            ) : (
              <span className="font-semibold text-mute">
                {moving ? "—" : "stoisz"}
              </span>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.1em] text-mute">
            Dokładność
          </dt>
          <dd
            className={cn(
              "metric font-bold",
              weak ? "text-warning" : "text-ink",
            )}
            data-testid="user-accuracy"
          >
            ±{Math.round(location.accuracy)} m
          </dd>
        </div>
      </dl>

      <p className="metric mt-1 flex flex-wrap gap-x-1.5 border-t border-line/70 pt-1 text-[7.5px] font-semibold text-mute">
        <span>maks. {formatSpeed(location.maxSpeedKmh)} km/h</span>
        <span>· trasa {formatKm(location.distanceM)}</span>
        {location.altitude !== null && <span>· {Math.round(location.altitude)} m n.p.m.</span>}
      </p>
      {(stale || weak || location.speedKmh === null) && (
        <p className="mt-0.5 text-[7.5px] font-semibold leading-snug text-warning">
          {stale
            ? `Ostatni odczyt GPS ${ageS} s temu.`
            : weak
              ? "Słaby sygnał GPS — pozycja przybliżona."
              : "Liczę prędkość z kolejnych odczytów…"}
        </p>
      )}
    </section>
  );
}

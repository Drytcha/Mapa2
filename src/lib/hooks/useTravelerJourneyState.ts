import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TripMapPlan } from "@/components/MapView";
import { stopDisplayName } from "@/lib/busStops";
import { reverseGeocode } from "@/lib/geo";
import {
  journeyToMapGeometry,
  journeyToRepairedMapGeometry,
  type Journey,
  type JourneyPoint as TripPoint,
} from "@/lib/journeyPlanner";
import {
  deleteTravelerPlace,
  fetchLastTravelerTrip,
  fetchSavedTravelerPlaces,
  saveLastTravelerTrip,
  saveTravelerPlace,
  type SavedTravelerPlace,
} from "@/lib/travelerPlaces";
import type { BusStop } from "@/lib/types";

export interface TravelerContextTarget {
  lat: number;
  lon: number;
  stop?: BusStop;
  addressLabel?: string | null;
}

export function useTravelerJourneyState({
  isPlanner,
  showToast,
  onClearContextMenu,
  onClearSelectedStop,
}: {
  isPlanner: boolean;
  showToast: (message: string) => void;
  onClearContextMenu: () => void;
  onClearSelectedStop: () => void;
}) {
  const [tripOpen, setTripOpen] = useState(false);
  const [tripPick, setTripPick] = useState<"origin" | "destination" | null>(
    null,
  );
  const [tripOrigin, setTripOrigin] = useState<TripPoint | null>(null);
  const [tripDest, setTripDest] = useState<TripPoint | null>(null);
  const [tripPreview, setTripPreview] = useState<Journey | null>(null);
  const [tripNonce, setTripNonce] = useState(0);
  const [savedPlaces, setSavedPlaces] = useState<SavedTravelerPlace[]>([]);
  const [lastSavedTrip, setLastSavedTrip] = useState<{
    origin: TripPoint | null;
    destination: TripPoint | null;
  } | null>(null);
  const hasModifiedTripRef = useRef(false);

  useEffect(() => {
    if (!tripPick) return;
    const cancelPick = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTripPick(null);
    };
    window.addEventListener("keydown", cancelPick);
    return () => window.removeEventListener("keydown", cancelPick);
  }, [tripPick]);

  useEffect(() => {
    let cancelled = false;
    fetchSavedTravelerPlaces()
      .then((places) => {
        if (!cancelled) setSavedPlaces(places);
      })
      .catch(() => undefined);
    fetchLastTravelerTrip()
      .then((last) => {
        if (!cancelled && (last.origin || last.destination)) {
          setLastSavedTrip(last);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasModifiedTripRef.current) return;
    if (!tripOrigin && !tripDest) return;
    const snapshot = { origin: tripOrigin, destination: tripDest };
    setLastSavedTrip(snapshot);
    const timer = window.setTimeout(() => {
      void saveLastTravelerTrip(snapshot.origin, snapshot.destination).catch(
        () => undefined,
      );
    }, 650);
    return () => window.clearTimeout(timer);
  }, [tripOrigin, tripDest]);

  const resolveTripPointAddress = useCallback(
    (kind: "origin" | "destination", lat: number, lon: number) => {
      reverseGeocode(lat, lon)
        .then((place) => {
          if (!place?.short) return;
          const nextLabel = place.short.slice(0, 56);
          const setter = kind === "origin" ? setTripOrigin : setTripDest;
          setter((current) =>
            current &&
            !current.stopId &&
            Math.abs(current.lat - lat) < 0.00001 &&
            Math.abs(current.lon - lon) < 0.00001
              ? { ...current, label: nextLabel }
              : current,
          );
        })
        .catch(() => undefined);
    },
    [],
  );

  const updateTripOrigin = useCallback((point: TripPoint | null) => {
    hasModifiedTripRef.current = true;
    setTripOrigin(point);
    setTripPreview(null);
  }, []);

  const updateTripDest = useCallback((point: TripPoint | null) => {
    hasModifiedTripRef.current = true;
    setTripDest(point);
    setTripPreview(null);
  }, []);

  const [repairedTripLegs, setRepairedTripLegs] = useState<{
    journeyId: string;
    legs: ReturnType<typeof journeyToMapGeometry>["legs"];
  } | null>(null);

  useEffect(() => {
    if (!tripPreview || isPlanner) return;
    const controller = new AbortController();
    const journey = tripPreview;
    journeyToRepairedMapGeometry(journey, controller.signal)
      .then((geometry) => {
        if (!controller.signal.aborted) {
          setRepairedTripLegs({ journeyId: journey.id, legs: geometry.legs });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [tripPreview, isPlanner]);

  const tripMapPlan = useMemo<TripMapPlan | null>(() => {
    if (isPlanner) return null;
    if (!tripOrigin && !tripDest) return null;
    const geometry = tripPreview
      ? journeyToMapGeometry(tripPreview)
      : { legs: [], markers: [] };
    const legs =
      tripPreview && repairedTripLegs?.journeyId === tripPreview.id
        ? repairedTripLegs.legs
        : geometry.legs;
    return {
      origin: tripOrigin,
      destination: tripDest,
      legs,
      markers: geometry.markers,
      key: tripPreview?.id ?? "points",
    };
  }, [isPlanner, tripOrigin, tripDest, tripPreview, repairedTripLegs]);

  const setTravelerStopEndpoint = useCallback(
    (stop: BusStop, target: "origin" | "destination") => {
      const point: TripPoint = {
        lat: stop.lat,
        lon: stop.lon,
        label: stopDisplayName(stop),
        stopId: stop.gtfsId,
        stopIds: stop.gtfsIds,
      };
      onClearSelectedStop();
      setTripPick(null);
      setTripOpen(true);
      if (target === "origin") {
        updateTripOrigin(point);
        showToast(
          tripDest
            ? `Start: ${point.label} — wyznaczam połączenia.`
            : `Start ustawiony na przystanku ${point.label}.`,
        );
      } else {
        updateTripDest(point);
        showToast(
          tripOrigin
            ? `Cel: ${point.label} — wyznaczam połączenia.`
            : `Cel ustawiony na przystanku ${point.label}.`,
        );
      }
    },
    [
      onClearSelectedStop,
      showToast,
      tripDest,
      tripOrigin,
      updateTripDest,
      updateTripOrigin,
    ],
  );

  const handleSwapTripPoints = useCallback(() => {
    if (!tripOrigin && !tripDest) return;
    onClearContextMenu();
    setTripPick(null);
    hasModifiedTripRef.current = true;
    const prevOrigin = tripOrigin;
    const prevDest = tripDest;
    setTripOrigin(prevDest);
    setTripDest(prevOrigin);
    setTripPreview(null);
    setTripOpen(true);
    showToast("Zamieniono miejsce startowe z docelowym.");
  }, [onClearContextMenu, showToast, tripDest, tripOrigin]);

  const handleClearTripPoints = useCallback(() => {
    onClearContextMenu();
    setTripPick(null);
    setTripOrigin(null);
    setTripDest(null);
    setTripPreview(null);
    showToast("Wyczyszczono miejsce startowe i docelowe.");
  }, [onClearContextMenu, showToast]);

  const handleSaveContextPlace = useCallback(
    async (ctx: TravelerContextTarget | null) => {
      if (!ctx) return;
      const { lat, lon, stop, addressLabel } = ctx;
      onClearContextMenu();
      let label = stop
        ? stopDisplayName(stop)
        : addressLabel || `Punkt (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
      if (!stop && !addressLabel) {
        try {
          const resolved = await reverseGeocode(lat, lon);
          if (resolved?.short) label = resolved.short.slice(0, 56);
        } catch {
          /* Fallback to coordinate label */
        }
      }
      try {
        const saved = await saveTravelerPlace({
          lat,
          lon,
          label,
          stopId: stop?.gtfsId,
          stopIds: stop?.gtfsIds,
        });
        if (saved) {
          setSavedPlaces((current) => [
            saved,
            ...current.filter((item) => item.id !== saved.id),
          ]);
          showToast(`Zapisano miejsce: ${saved.label}.`);
        } else {
          showToast("Nie udało się zapisać miejsca.");
        }
      } catch {
        showToast("Nie udało się zapisać miejsca.");
      }
    },
    [onClearContextMenu, showToast],
  );

  const handleDeleteSavedPlace = useCallback(
    async (id: number) => {
      try {
        const removed = await deleteTravelerPlace(id);
        if (removed) {
          setSavedPlaces((current) => current.filter((item) => item.id !== id));
          showToast("Usunięto zapisane miejsce.");
        }
      } catch {
        showToast("Nie udało się usunąć miejsca.");
      }
    },
    [showToast],
  );

  const handleRestoreLastTrip = useCallback(() => {
    if (!lastSavedTrip) return;
    hasModifiedTripRef.current = true;
    setTripOrigin(lastSavedTrip.origin);
    setTripDest(lastSavedTrip.destination);
    setTripPreview(null);
    setTripOpen(true);
    showToast("Przywrócono ostatnie punkty podróży.");
  }, [lastSavedTrip, showToast]);

  return {
    tripOpen,
    setTripOpen,
    tripPick,
    setTripPick,
    tripOrigin,
    tripDest,
    tripPreview,
    setTripPreview,
    tripNonce,
    setTripNonce,
    savedPlaces,
    lastSavedTrip,
    resolveTripPointAddress,
    updateTripOrigin,
    updateTripDest,
    tripMapPlan,
    setTravelerStopEndpoint,
    handleSwapTripPoints,
    handleClearTripPoints,
    handleSaveContextPlace,
    handleDeleteSavedPlace,
    handleRestoreLastTrip,
  };
}

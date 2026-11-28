import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KursowkaShapeOverlay, MapHandle } from "@/components/MapView";
import {
  buildCourseNavRoute,
  evaluateCourseNavigation,
  type CourseNavRoute,
} from "@/lib/courseNavigation";
import type { LocationStatus, UserLocation } from "@/lib/useUserLocation";

export function useCourseNavigation({
  userLocation,
  locationStatus,
  startLocation,
  stopNavigation,
  onClearBusAndCourseTarget,
  onCollapseMobileDrawers,
  mapRef,
  showToast,
}: {
  userLocation: UserLocation | null;
  locationStatus: LocationStatus;
  startLocation: () => void;
  stopNavigation: () => void;
  onClearBusAndCourseTarget: () => void;
  onCollapseMobileDrawers: () => void;
  mapRef: React.RefObject<MapHandle | null>;
  showToast: (message: string) => void;
}) {
  const [courseNavRoute, setCourseNavRoute] = useState<CourseNavRoute | null>(
    null,
  );
  const [courseNavMode, setCourseNavMode] = useState<"gps" | "sim">("gps");
  const [courseNavSimMeters, setCourseNavSimMeters] = useState(0);
  const [courseNavSimPlaying, setCourseNavSimPlaying] = useState(false);
  const [courseNavSimSpeed, setCourseNavSimSpeed] = useState<1 | 3 | 8>(1);
  const [courseNavStartedAt, setCourseNavStartedAt] = useState<number>(() =>
    Date.now(),
  );
  const [courseNavPunctualityMode, setCourseNavPunctualityMode] = useState<
    "schedule" | "relative"
  >("schedule");
  const [courseNavManualStopOffset, setCourseNavManualStopOffset] = useState(0);
  const [courseNavFollowCamera, setCourseNavFollowCamera] = useState(true);
  const courseNavPrevAlongRef = useRef(0);

  const stopCourseNavigation = useCallback(() => {
    setCourseNavRoute(null);
    setCourseNavSimPlaying(false);
    setCourseNavSimMeters(0);
    setCourseNavManualStopOffset(0);
    courseNavPrevAlongRef.current = 0;
  }, []);

  const startCourseNavigation = useCallback(
    (
      source:
        | KursowkaShapeOverlay
        | NonNullable<KursowkaShapeOverlay["course"]>,
    ) => {
      const built = buildCourseNavRoute(source);
      if (!built) {
        showToast("Brak geometrii trasy do uruchomienia nawigacji.");
        return;
      }
      stopNavigation();
      onClearBusAndCourseTarget();
      courseNavPrevAlongRef.current = 0;
      setCourseNavManualStopOffset(0);
      setCourseNavSimMeters(0);
      const now = Date.now();
      setCourseNavStartedAt(now);
      setCourseNavFollowCamera(true);

      const withinScheduleWindow =
        built.startMs !== null &&
        built.endMs !== null &&
        now >= built.startMs - 45 * 60_000 &&
        now <= built.endMs + 45 * 60_000;
      setCourseNavPunctualityMode(
        withinScheduleWindow ? "schedule" : "relative",
      );

      const gpsUnavailable =
        locationStatus === "denied" || locationStatus === "unavailable";
      if (gpsUnavailable) {
        setCourseNavMode("sim");
        setCourseNavSimPlaying(true);
      } else {
        startLocation();
        setCourseNavMode("gps");
        setCourseNavSimPlaying(false);
      }

      setCourseNavRoute(built);
      onCollapseMobileDrawers();

      const startPt = built.path[0];
      if (startPt) {
        mapRef.current?.centerOn(startPt[0], startPt[1], 16);
      }
      showToast(
        gpsUnavailable
          ? `Uruchomiono symulację przejazdu: ${built.title}.`
          : `Nawigacja po trasie kursu uruchomiona: ${built.title}.`,
      );
    },
    [
      locationStatus,
      mapRef,
      onClearBusAndCourseTarget,
      onCollapseMobileDrawers,
      showToast,
      startLocation,
      stopNavigation,
    ],
  );

  useEffect(() => {
    if (!courseNavRoute || courseNavMode !== "sim" || !courseNavSimPlaying) {
      return;
    }
    const stepMs = 120;
    const metersPerTick = 9.5 * (stepMs / 1000) * courseNavSimSpeed;
    const timer = window.setInterval(() => {
      setCourseNavSimMeters((prev) => {
        const next = Math.min(courseNavRoute.totalMeters, prev + metersPerTick);
        if (next >= courseNavRoute.totalMeters) {
          setCourseNavSimPlaying(false);
        }
        return next;
      });
    }, stepMs);
    return () => window.clearInterval(timer);
  }, [courseNavRoute, courseNavMode, courseNavSimPlaying, courseNavSimSpeed]);

  // Bez 1-sekundowego zegara na poziomie głównego widoku: odświeżamy geometrię
  // wyłącznie przy faktycznej zmianie pozycji GPS / symulatora / przystanku!
  const courseNavState = useMemo(() => {
    if (!courseNavRoute) return null;
    const evaluated = evaluateCourseNavigation({
      route: courseNavRoute,
      mode: courseNavMode,
      gps: userLocation
        ? {
            lat: userLocation.lat,
            lon: userLocation.lon,
            accuracy: userLocation.accuracy,
            speedKmh: userLocation.speedKmh,
            heading: userLocation.heading,
          }
        : null,
      simMeters: courseNavSimMeters,
      prevAlongMeters: courseNavPrevAlongRef.current,
      manualStopOffset: courseNavManualStopOffset,
      nowMs: Date.now(),
      startedAtMs: courseNavStartedAt,
      punctualityMode: courseNavPunctualityMode,
    });
    courseNavPrevAlongRef.current = evaluated.alongMeters;
    return evaluated;
  }, [
    courseNavRoute,
    courseNavMode,
    userLocation,
    courseNavSimMeters,
    courseNavManualStopOffset,
    courseNavStartedAt,
    courseNavPunctualityMode,
  ]);

  const quantizedAlongM = courseNavState
    ? Math.round(courseNavState.alongMeters)
    : -1;
  const passedStopCount = courseNavState?.passedStopCount ?? 0;

  const courseNavProgressOverlay = useMemo(() => {
    if (!courseNavState || quantizedAlongM < 0) return null;
    return {
      passed: courseNavState.splitPath.passed,
      remaining: courseNavState.splitPath.remaining,
      passedStopCount,
    };
    // Kwantyzacja co 1 m zapobiega przebudowie polilinii przy mikro-szumie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseNavRoute, quantizedAlongM, passedStopCount]);

  const handleNavModeChange = useCallback(
    (nextMode: "gps" | "sim") => {
      setCourseNavMode(nextMode);
      if (nextMode === "gps") {
        startLocation();
        setCourseNavSimPlaying(false);
      } else {
        if (courseNavState) {
          setCourseNavSimMeters(courseNavState.alongMeters);
        }
        setCourseNavSimPlaying(true);
      }
    },
    [courseNavState, startLocation],
  );

  const handleToggleSimPlay = useCallback(() => {
    setCourseNavSimPlaying((playing) => {
      if (
        !playing &&
        courseNavRoute &&
        courseNavSimMeters >= courseNavRoute.totalMeters - 5
      ) {
        setCourseNavSimMeters(0);
        courseNavPrevAlongRef.current = 0;
      }
      return !playing;
    });
  }, [courseNavRoute, courseNavSimMeters]);

  const handleCycleSimSpeed = useCallback(() => {
    setCourseNavSimSpeed((cur) => (cur === 1 ? 3 : cur === 3 ? 8 : 1));
  }, []);

  const handleRecenterNavCamera = useCallback(() => {
    setCourseNavFollowCamera(true);
    if (courseNavState) {
      mapRef.current?.centerOn(
        courseNavState.position[0],
        courseNavState.position[1],
        16,
      );
    }
  }, [courseNavState, mapRef]);

  const handleTogglePunctualityMode = useCallback(() => {
    setCourseNavPunctualityMode((cur) =>
      cur === "schedule" ? "relative" : "schedule",
    );
  }, []);

  const handleStepNavStop = useCallback(
    (delta: -1 | 1) => {
      if (!courseNavRoute || !courseNavState) return;
      if (courseNavMode === "sim") {
        const targetIdx = Math.min(
          Math.max(0, courseNavState.nextStopIndex + delta),
          courseNavRoute.stops.length - 1,
        );
        const stop = courseNavRoute.stops[targetIdx];
        if (stop) {
          const m = Math.max(0, stop.alongMeters - 28);
          courseNavPrevAlongRef.current = m;
          setCourseNavSimMeters(m);
        }
      } else {
        setCourseNavManualStopOffset((cur) => cur + delta);
      }
    },
    [courseNavMode, courseNavRoute, courseNavState],
  );

  const handleJumpToNavStop = useCallback(
    (stopIndex: number) => {
      if (!courseNavRoute) return;
      const stop = courseNavRoute.stops[stopIndex];
      if (!stop) return;
      setCourseNavFollowCamera(false);
      mapRef.current?.centerOn(stop.lat, stop.lon, 16);
    },
    [courseNavRoute, mapRef],
  );

  return {
    courseNavRoute,
    courseNavMode,
    courseNavSimPlaying,
    courseNavSimSpeed,
    courseNavStartedAt,
    courseNavPunctualityMode,
    courseNavFollowCamera,
    setCourseNavFollowCamera,
    courseNavState,
    courseNavProgressOverlay,
    stopCourseNavigation,
    startCourseNavigation,
    handleNavModeChange,
    handleToggleSimPlay,
    handleCycleSimSpeed,
    handleRecenterNavCamera,
    handleTogglePunctualityMode,
    handleStepNavStop,
    handleJumpToNavStop,
  };
}

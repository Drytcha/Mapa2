"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import L from "leaflet";
import { coordKey } from "@/lib/core/spatial";
import { escapeHtml } from "@/lib/core/text";
import { TILES } from "@/lib/services";
import { isWaypointSet } from "@/lib/data";
import { buildBusMarker } from "@/lib/busMarker";
import { stopDisplayName, WALBRZYCH_CENTER, WALBRZYCH_ZOOM } from "@/lib/busStops";
import type {
  BusStop,
  LiveBusVehicle,
  MapStyle,
  RouteData,
  ThemeMode,
  TrafficSignalIntersection,
  Waypoint,
} from "@/lib/types";
import type { TurnaroundSpot } from "@/lib/engine/turnarounds";
import type { CoursePreview } from "@/lib/engine/gtfsStore";
import { formatWarsawClock } from "@/lib/core/time";

export interface MapUserLocation {
  lat: number;
  lon: number;
  accuracy: number;
  heading: number | null;
}

export interface MapHandle {
  fitRoute: () => void;
  fitOverlay: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  centerOn: (lat: number, lon: number, zoom?: number) => void;
  getBounds: () => { south: number; west: number; north: number; east: number } | null;
}

export interface KursowkaShapeOverlay {
  title: string;
  color: string;
  polylines: [number, number][][];
  stops: Array<{ name: string; lat: number; lon: number }>;
  /** Present only when previewing one scheduled course, not a whole brigade. */
  course?: CoursePreview;
}

export interface TripMapPoint {
  lat: number;
  lon: number;
  label: string;
}

export interface TripMapLeg {
  kind: "walk" | "bus";
  path: [number, number][];
  color?: string;
  label?: string;
}

export interface TripMapMarker {
  kind: "board" | "alight";
  lat: number;
  lon: number;
  label: string;
  routeShort?: string;
  color?: string;
  textColor?: string;
}

/** Geometria planu podróży pasażera rysowana na mapie (start, odcinki, przesiadki, cel). */
export interface TripMapPlan {
  origin: TripMapPoint | null;
  destination: TripMapPoint | null;
  legs: TripMapLeg[];
  markers: TripMapMarker[];
  key?: string;
}

interface MapViewProps {
  route: RouteData;
  waypoints: Waypoint[];
  mapStyle: MapStyle;
  theme: ThemeMode;
  fitNonce: number;
  pickMode?: boolean;
  draftMode?: boolean;
  busStops?: BusStop[];
  selectedStopId?: string | null;
  nearRouteIds?: Set<string>;
  usedStopKeys?: Set<string>;
  onBusStopClick?: (stop: BusStop) => void;
  liveBuses?: LiveBusVehicle[];
  showLiveBuses?: boolean;
  /** Opt-in identifiers; direction, line, speed and delay are always shown. */
  busLabelKursowka?: boolean;
  busLabelVehicleNumber?: boolean;
  selectedLiveBusId?: string | null;
  onLiveBusClick?: (bus: LiveBusVehicle) => void;
  trafficSignals?: TrafficSignalIntersection[];
  showTrafficSignals?: boolean;
  turnaroundSpots?: TurnaroundSpot[];
  showTurnarounds?: boolean;
  kursowkaOverlay?: KursowkaShapeOverlay | null;
  tripPlan?: TripMapPlan | null;
  tripOriginEditing?: boolean;
  onTripOriginPick?: () => void;
  onTripOriginMove?: (lat: number, lon: number) => void;
  tripDestinationEditing?: boolean;
  onTripDestinationPick?: () => void;
  onTripDestinationMove?: (lat: number, lon: number) => void;
  navCoord?: [number, number] | null;
  followNav?: boolean;
  focus?: { lat: number; lon: number; zoom?: number; nonce: number } | null;
  /** Pozycja GPS użytkownika (kropka + okrąg dokładności). */
  userLocation?: MapUserLocation | null;
  /** Gdy true, mapa podąża za użytkownikiem; ręczne przesunięcie mapy to wyłącza. */
  followUser?: boolean;
  /** Każda zmiana wycentrowuje mapę na użytkowniku. */
  centerUserNonce?: number;
  onUserPan?: () => void;
  onLineClick: (point: [number, number]) => void;
  onMarkerDrag: (id: string, lat: number, lon: number) => void;
  onMapClick: (lat: number, lon: number) => void;
  onMapContextMenu: (
    lat: number,
    lon: number,
    clientX: number,
    clientY: number,
    stop?: BusStop
  ) => void;
}

const vehicleSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.6 3.9 21l8.1-4.7 8.1 4.7L12 2.6Z" fill="currentColor"/></svg>`;

const busGlyph = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 17V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11"/><path d="M4 11h16"/><path d="M4 17h16"/><circle cx="7.5" cy="19.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="19.5" r="1.2" fill="currentColor" stroke="none"/></svg>`;

function computeStopVisualState(
  stop: BusStop,
  selectedStopId: string | null,
  nearRouteIds?: Set<string>,
  usedStopKeys?: Set<string>
): string {
  return [
    stop.id === selectedStopId ? "on" : "",
    nearRouteIds?.has(stop.id) ? "route" : "",
    usedStopKeys?.has(coordKey(stop.lat, stop.lon, 5)) ? "used" : "",
    stop.source === "osm" ? "osm" : "",
  ].join("|");
}

function createStopDivIcon(id: string, state: string): L.DivIcon {
  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="bus-stop${state.includes("on") ? " bus-stop--on" : ""}${
      state.includes("route") ? " bus-stop--route" : ""
    }${state.includes("used") ? " bus-stop--used" : ""}${
      state.includes("osm") ? " bus-stop--osm" : ""
    }" data-stop-id="${escapeHtml(id)}" aria-hidden="true">${busGlyph}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

interface LiveBusMarkerEntry {
  marker: L.Marker;
  html: string;
  tooltip: string;
  selected: boolean;
}

const MapView = forwardRef<MapHandle, MapViewProps>(function MapView(
  {
    route,
    waypoints,
    mapStyle,
    theme,
    fitNonce,
    pickMode = false,
    draftMode = false,
    busStops = [],
    selectedStopId = null,
    nearRouteIds,
    usedStopKeys,
    onBusStopClick,
    liveBuses = [],
    showLiveBuses = true,
    busLabelKursowka = false,
    busLabelVehicleNumber = false,
    selectedLiveBusId = null,
    onLiveBusClick,
    trafficSignals = [],
    showTrafficSignals = true,
    turnaroundSpots = [],
    showTurnarounds = true,
    kursowkaOverlay = null,
    tripPlan = null,
    tripOriginEditing = false,
    onTripOriginPick,
    onTripOriginMove,
    tripDestinationEditing = false,
    onTripDestinationPick,
    onTripDestinationMove,
    navCoord,
    followNav = false,
    focus,
    userLocation = null,
    followUser = false,
    centerUserNonce = 0,
    onUserPan,
    onLineClick,
    onMarkerDrag,
    onMapClick,
    onMapContextMenu,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer[]>([]);
  const routeGroupRef = useRef<L.LayerGroup | null>(null);
  const kursowkaGroupRef = useRef<L.LayerGroup | null>(null);
  const tripGroupRef = useRef<L.LayerGroup | null>(null);
  const tripOriginRef = useRef<L.Marker | null>(null);
  const tripDestinationRef = useRef<L.Marker | null>(null);
  const lastTripFitRef = useRef("");
  const tripOriginPickRef = useRef(onTripOriginPick);
  const tripOriginMoveRef = useRef(onTripOriginMove);
  const tripDestinationPickRef = useRef(onTripDestinationPick);
  const tripDestinationMoveRef = useRef(onTripDestinationMove);
  const signalGroupRef = useRef<L.LayerGroup | null>(null);
  const turnaroundGroupRef = useRef<L.LayerGroup | null>(null);
  const vehicleGroupRef = useRef<L.LayerGroup | null>(null);
  const liveBusMarkersRef = useRef<Map<string, LiveBusMarkerEntry>>(new Map());
  const liveBusByIdRef = useRef<Map<string, LiveBusVehicle>>(new Map());
  const markerGroupRef = useRef<L.LayerGroup | null>(null);
  const stopGroupRef = useRef<L.LayerGroup | null>(null);
  const stopMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const stopStateRef = useRef<Map<string, string>>(new Map());
  const navMarkerRef = useRef<L.Marker | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const userCircleRef = useRef<L.Circle | null>(null);
  const userPanRef = useRef(onUserPan);
  const flyingRef = useRef(false);
  const lastCenterNonceRef = useRef(0);
  const hasFittedRef = useRef(false);
  const lastFitNonceRef = useRef(-1);

  const pickModeRef = useRef(pickMode);
  const lineClickRef = useRef(onLineClick);
  const dragRef = useRef(onMarkerDrag);
  const mapClickRef = useRef(onMapClick);
  const contextMenuRef = useRef(onMapContextMenu);
  const stopClickRef = useRef(onBusStopClick);
  const liveBusClickRef = useRef(onLiveBusClick);
  const routeRef = useRef(route);
  const overlayRef = useRef(kursowkaOverlay);
  useEffect(() => {
    pickModeRef.current = pickMode;
    stopClickRef.current = onBusStopClick;
    liveBusClickRef.current = onLiveBusClick;
    lineClickRef.current = onLineClick;
    dragRef.current = onMarkerDrag;
    mapClickRef.current = onMapClick;
    contextMenuRef.current = onMapContextMenu;
    routeRef.current = route;
    overlayRef.current = kursowkaOverlay;
    tripOriginPickRef.current = onTripOriginPick;
    tripOriginMoveRef.current = onTripOriginMove;
    tripDestinationPickRef.current = onTripDestinationPick;
    tripDestinationMoveRef.current = onTripDestinationMove;
    userPanRef.current = onUserPan;
  });

  const dispatchContextMenu = (
    event: L.LeafletMouseEvent,
    lat = event.latlng.lat,
    lon = event.latlng.lng,
    stop?: BusStop
  ) => {
    const original = event.originalEvent as MouseEvent | undefined;
    if (original) L.DomEvent.stop(original);
    const container = containerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;
    const rect = container.getBoundingClientRect();
    const pt = event.containerPoint ?? map.latLngToContainerPoint([lat, lon]);
    const clientX =
      !original || (original.clientX === 0 && original.clientY === 0)
        ? rect.left + pt.x
        : original.clientX;
    const clientY =
      !original || (original.clientX === 0 && original.clientY === 0)
        ? rect.top + pt.y
        : original.clientY;
    contextMenuRef.current(lat, lon, clientX, clientY, stop);
  };

  const fitBounds = () => {
    const map = mapRef.current;
    if (!map) return;
    const coords = routeRef.current.coords;
    if (!coords.length) return;
    const bounds = L.latLngBounds(coords);
    const narrow = window.innerWidth < 1024;
    map.fitBounds(bounds, {
      paddingTopLeft: narrow ? [32, 110] : [56, 90],
      paddingBottomRight: narrow ? [32, 190] : [70, 150],
      maxZoom: 15,
      animate: true,
      duration: 0.8,
    });
  };

  const fitOverlayMap = () => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay?.polylines.length) {
      fitBounds();
      return;
    }
    const allCoords = overlay.polylines.flat();
    if (allCoords.length < 2) return;
    const width = map.getSize().x;
    map.fitBounds(L.latLngBounds(allCoords), {
      paddingTopLeft: overlay.course
        ? [width >= 760 ? Math.min(340, Math.round(width * 0.34)) : 36, 90]
        : [56, 56],
      paddingBottomRight: overlay.course ? [56, 100] : [56, 56],
      maxZoom: 15,
      animate: true,
      duration: 0.8,
    });
  };

  useImperativeHandle(ref, () => ({
    fitRoute: () => {
      userPanRef.current?.();
      fitBounds();
    },
    fitOverlay: () => {
      userPanRef.current?.();
      fitOverlayMap();
    },
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    centerOn: (lat, lon, zoom = 13) => {
      // Inne wycentrowanie (przystanek, autobus, Wałbrzych) przerywa śledzenie GPS.
      userPanRef.current?.();
      mapRef.current?.flyTo([lat, lon], zoom, { duration: 0.8 });
    },
    getBounds: () => {
      const bounds = mapRef.current?.getBounds();
      if (!bounds) return null;
      return {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      };
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 4,
      maxZoom: 19,
      zoomSnap: 0.5,
      preferCanvas: false,
    }).setView(WALBRZYCH_CENTER, WALBRZYCH_ZOOM);
    (container as HTMLElement & { __map?: L.Map }).__map = map;
    map.attributionControl.setPrefix(
      '<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>'
    );
    map.attributionControl.addAttribution(
      'Trasy piesze: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noreferrer">OSRM / FOSSGIS</a>'
    );
    mapRef.current = map;

    const labelPane = map.createPane("labels");
    labelPane.style.zIndex = "250";
    labelPane.style.pointerEvents = "none";

    const kursowkaPane = map.createPane("kursowka");
    kursowkaPane.style.zIndex = "510";

    const courseStopsPane = map.createPane("courseStops");
    courseStopsPane.style.zIndex = "625";

    const stopPane = map.createPane("stops");
    stopPane.style.zIndex = "540";

    const signalPane = map.createPane("signals");
    signalPane.style.zIndex = "550";

    const vehiclePane = map.createPane("vehicles");
    vehiclePane.style.zIndex = "680";

    const tripPane = map.createPane("trip");
    tripPane.style.zIndex = "575";

    const userPane = map.createPane("user");
    userPane.style.zIndex = "690";
    userPane.style.pointerEvents = "none";

    routeGroupRef.current = L.layerGroup().addTo(map);
    kursowkaGroupRef.current = L.layerGroup().addTo(map);
    tripGroupRef.current = L.layerGroup().addTo(map);
    stopGroupRef.current = L.layerGroup().addTo(map);
    signalGroupRef.current = L.layerGroup().addTo(map);
    turnaroundGroupRef.current = L.layerGroup().addTo(map);
    vehicleGroupRef.current = L.layerGroup().addTo(map);
    markerGroupRef.current = L.layerGroup().addTo(map);

    // Tylko ręczne przeciągnięcie mapy wyłącza śledzenie (flyTo/panTo go nie wywołują).
    map.on("dragstart", () => userPanRef.current?.());
    map.on("click", (event: L.LeafletMouseEvent) => {
      mapClickRef.current(event.latlng.lat, event.latlng.lng);
    });
    map.on("contextmenu", (event: L.LeafletMouseEvent) => {
      dispatchContextMenu(event);
    });

    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(container);

    return () => {
      observer.disconnect();
      tileRef.current = [];
      stopMarkersRef.current.clear();
      stopStateRef.current.clear();
      liveBusMarkersRef.current.clear();
      liveBusByIdRef.current.clear();
      delete (container as HTMLElement & { __map?: L.Map }).__map;
      map.remove();
      mapRef.current = null;
      routeGroupRef.current = null;
      kursowkaGroupRef.current = null;
      tripGroupRef.current = null;
      tripOriginRef.current = null;
      tripDestinationRef.current = null;
      lastTripFitRef.current = "";
      signalGroupRef.current = null;
      turnaroundGroupRef.current = null;
      vehicleGroupRef.current = null;
      markerGroupRef.current = null;
      stopGroupRef.current = null;
      navMarkerRef.current = null;
      userMarkerRef.current = null;
      userCircleRef.current = null;
      flyingRef.current = false;
      hasFittedRef.current = false;
    };
  }, []);

  /* Base tiles + labels */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tileRef.current.forEach((layer) => layer.remove());
    const config = TILES[mapStyle];
    const base = L.tileLayer(config.base, {
      attribution: config.attribution,
      maxZoom: config.maxZoom,
      maxNativeZoom: config.maxZoom,
      detectRetina: true,
      crossOrigin: true,
      className: mapStyle === "dark" ? "basemap-layer basemap-layer--dark" : "basemap-layer",
    });
    base.addTo(map);
    const layers = [base];
    if (config.labels) {
      const labels = L.tileLayer(config.labels, {
        maxZoom: config.maxZoom,
        maxNativeZoom: config.maxZoom,
        detectRetina: true,
        crossOrigin: true,
        pane: "labels",
        className: "basemap-labels",
        opacity: mapStyle === "satellite" ? 0.85 : 1,
      });
      labels.addTo(map);
      layers.push(labels);
    }
    tileRef.current = layers;
  }, [mapStyle]);

  /* Active planned route */
  useEffect(() => {
    const map = mapRef.current;
    const group = routeGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (route.coords.length < 2) return;

    const darkTiles = mapStyle !== "light";
    const main = darkTiles ? "#d7f36e" : "#0d4f3b";
    const casing = darkTiles ? "#0a1712" : "#ffffff";
    const flow = darkTiles ? "#3b6b4f" : "#d7f36e";

    L.polyline(route.coords, {
      color: casing,
      weight: 11,
      opacity: 0.96,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(group);

    L.polyline(route.coords, {
      color: main,
      weight: 5.2,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      className: "route-main",
      interactive: false,
    }).addTo(group);

    L.polyline(route.coords, {
      color: flow,
      weight: 2.6,
      opacity: 0.95,
      lineCap: "round",
      className: "route-flow",
      interactive: false,
    }).addTo(group);

    const hitArea = L.polyline(route.coords, {
      color: "#000000",
      weight: 20,
      opacity: 0.001,
      lineCap: "round",
    }).addTo(group);

    // A DOM click on the path always follows the mousedown gesture below, which already
    // inserted the point on mouseup — keep the synthetic click handler inert (except in
    // pick mode, where mousedown returns early and the click is the only signal).
    let suppressClick = true;

    hitArea.on("mousedown", (event: L.LeafletMouseEvent) => {
      const mapInstance = mapRef.current;
      if (
        !mapInstance ||
        !event.originalEvent ||
        event.originalEvent.button !== 0 ||
        pickModeRef.current
      ) {
        return;
      }
      L.DomEvent.stop(event.originalEvent);
      const ghost = L.marker(event.latlng, {
        icon: L.divIcon({
          className: "pin-wrap",
          html: '<div class="pin pin--via" style="box-shadow:0 0 0 6px rgba(13,79,59,.16), 0 6px 18px rgba(5,30,20,.28)">+</div>',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        interactive: false,
        zIndexOffset: 1500,
      }).addTo(mapInstance);
      mapInstance.dragging.disable();
      let finished = false;
      let lastLatLng: L.LatLng | null = event.latlng;

      const finish = (latlng: L.LatLng | null) => {
        if (finished) return;
        finished = true;
        mapInstance.off("mousemove", move);
        mapInstance.off("mouseup", up);
        window.removeEventListener("mouseup", documentUp);
        mapInstance.removeLayer(ghost);
        mapInstance.dragging.enable();
        // Fall back to the last on-map position so releasing the button outside the map
        // still drops the point where the ghost pin was shown.
        const target = latlng ?? lastLatLng;
        if (target) lineClickRef.current([target.lat, target.lng]);
      };
      const move = (moveEvent: L.LeafletMouseEvent) => {
        lastLatLng = moveEvent.latlng;
        ghost.setLatLng(moveEvent.latlng);
      };
      const up = (upEvent: L.LeafletMouseEvent) => finish(upEvent.latlng);
      const documentUp = () => finish(null);

      mapInstance.on("mousemove", move);
      mapInstance.on("mouseup", up);
      // Bubble phase: Leaflet's map "mouseup" (bound to the map container) fires first for
      // releases over the map; only releases outside the map reach this listener.
      window.addEventListener("mouseup", documentUp);
    });

    hitArea.on("click", (event: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(event.originalEvent);
      if (pickModeRef.current) {
        mapClickRef.current(event.latlng.lat, event.latlng.lng);
        return;
      }
      if (suppressClick) return;
      lineClickRef.current([event.latlng.lat, event.latlng.lng]);
    });
    hitArea.bindTooltip("Przeciągnij lub kliknij, aby dodać punkt pośredni", {
      sticky: true,
      direction: "top",
      className: "waypoint-tooltip waypoint-tooltip--hint",
      offset: [0, -8],
    });
    hitArea.bringToFront();

    let fitTimer: number | undefined;
    if (!hasFittedRef.current || lastFitNonceRef.current !== fitNonce) {
      hasFittedRef.current = true;
      lastFitNonceRef.current = fitNonce;
      fitTimer = window.setTimeout(fitBounds, 140);
    }
    return () => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
    };
  }, [route, mapStyle, fitNonce]);

  /* GTFS overlays: an entire brigade, or one exact course with timed stop markers. */
  useEffect(() => {
    const map = mapRef.current;
    const group = kursowkaGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (!kursowkaOverlay || !kursowkaOverlay.polylines.length) return;

    // The course line is ALWAYS continuous. Dashes made brigade previews and course
    // data look like a broken route, so they are gone. Only a stop-chain course
    // (no street geometry at all) is drawn a bit lighter to mark it as approximate.
    const lineColor = kursowkaOverlay.color || "#0d4f3b";
    const casingWeight = kursowkaOverlay.course ? 9 : 8;
    const lineWeight = kursowkaOverlay.course ? 5 : 4.5;
    const lineOpacity = kursowkaOverlay.course?.approximate ? 0.72 : 0.96;
    const drawable = kursowkaOverlay.polylines.filter((line) => line.length >= 2);

    // Pass 1: every white casing. Pass 2: every coloured line on top of them.
    // Drawing casing+line per shape lets a later casing cut through an earlier
    // coloured line wherever two variants share a street (visible gaps).
    const strokes: Array<{ path: [number, number][]; opacity: number }> = drawable.map(
      (path) => ({ path, opacity: lineOpacity })
    );
    for (const { path } of strokes) {
      L.polyline(path, {
        color: "#ffffff",
        weight: casingWeight,
        opacity: 0.85,
        lineCap: "round",
        lineJoin: "round",
        pane: "kursowka",
        interactive: false,
      }).addTo(group);
    }
    for (const { path, opacity } of strokes) {
      L.polyline(path, {
        color: lineColor,
        weight: lineWeight,
        opacity,
        lineCap: "round",
        lineJoin: "round",
        pane: "kursowka",
        interactive: false,
      }).addTo(group);
    }

    if (kursowkaOverlay.course) {
      const course = kursowkaOverlay.course;
      course.stops.forEach((stop, index) => {
        const isFirst = index === 0;
        const isLast = index === course.stops.length - 1;
        const kind = isFirst ? "Start" : isLast ? "Koniec" : `Przystanek ${index + 1}`;
        const time = formatWarsawClock(isLast ? stop.arrivalMs : stop.departureMs);
        const tooltip = `<b>${kind} · ${escapeHtml(time)}${stop.afterMidnight ? " (+1 dzień)" : ""}</b><br>${escapeHtml(stop.name)}`;
        L.circleMarker([stop.lat, stop.lon], {
          pane: "courseStops",
          radius: isFirst || isLast ? 8 : 4.5,
          weight: 2.5,
          color: "#ffffff",
          fillColor: isFirst ? "#0891b2" : isLast ? "#e11d48" : course.color,
          fillOpacity: 1,
          bubblingMouseEvents: false,
        })
          .bindTooltip(tooltip, {
            direction: isLast ? "bottom" : "top",
            offset: isLast ? [0, 10] : [0, -10],
            permanent: isFirst || isLast,
            className: "waypoint-tooltip",
          })
          .addTo(group);
      });
    }
    // Podgląd całej linii / brygady: kropki przystanków z nazwą po najechaniu.
    if (!kursowkaOverlay.course) {
      for (const stop of kursowkaOverlay.stops) {
        L.circleMarker([stop.lat, stop.lon], {
          pane: "courseStops",
          radius: 3.5,
          weight: 1.5,
          color: "#ffffff",
          fillColor: lineColor,
          fillOpacity: 1,
          bubblingMouseEvents: false,
        })
          .bindTooltip(escapeHtml(stop.name), {
            direction: "top",
            offset: [0, -6],
            className: "waypoint-tooltip",
          })
          .addTo(group);
      }
    }
    fitOverlayMap();
  }, [kursowkaOverlay]);

  /* Planer podróży pasażera: start, odcinki piesze/autobusowe, przesiadki i cel */
  useEffect(() => {
    const map = mapRef.current;
    const group = tripGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    tripOriginRef.current = null;
    tripDestinationRef.current = null;
    if (!tripPlan || (!tripPlan.origin && !tripPlan.destination)) {
      lastTripFitRef.current = "";
      return;
    }

    const points: [number, number][] = [];

    const endpointIcon = (kind: "origin" | "destination", text: string) => {
      const inner =
        kind === "origin"
          ? `<span class="trip-marker trip-marker--origin"><span class="trip-marker-ring"></span><span class="trip-marker-core"></span></span>`
          : `<span class="trip-marker trip-marker--destination"><span class="trip-marker-pin"></span></span>`;
      return L.divIcon({
        className: "pin-wrap",
        html: `<div class="trip-marker-wrap">${inner}<span class="trip-marker-label">${escapeHtml(text)}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
    };

    const stopIcon = (marker: TripMapMarker) => {
      const inner =
        marker.kind === "board"
          ? `<span class="trip-marker trip-marker--board" style="background:${escapeHtml(marker.color || "#0d4f3b")};color:${escapeHtml(marker.textColor || "#ffffff")}">${escapeHtml(marker.routeShort || "")}</span>`
          : `<span class="trip-marker trip-marker--alight"></span>`;
      return L.divIcon({
        className: "pin-wrap",
        html: `<div class="trip-marker-wrap">${inner}<span class="trip-marker-label">${escapeHtml(marker.label)}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
    };

    const walkStyle: L.PolylineOptions = {
      color: theme === "dark" ? "#5eead4" : "#0f766e",
      weight: 3,
      opacity: 0.9,
      dashArray: "2 7",
      lineCap: "round",
      pane: "trip",
      interactive: false,
    };

    for (const leg of tripPlan.legs) {
      if (leg.path.length < 2) continue;
      points.push(...leg.path);
      if (leg.kind === "walk") {
        L.polyline(leg.path, walkStyle).addTo(group);
        continue;
      }
      L.polyline(leg.path, {
        color: "#ffffff",
        weight: 9,
        opacity: 0.92,
        lineCap: "round",
        lineJoin: "round",
        pane: "trip",
        interactive: false,
      }).addTo(group);
      const line = L.polyline(leg.path, {
        color: leg.color || "#0d4f3b",
        weight: 5,
        opacity: 0.98,
        lineCap: "round",
        lineJoin: "round",
        pane: "trip",
        interactive: Boolean(leg.label),
      }).addTo(group);
      if (leg.label) {
        line.bindTooltip(escapeHtml(leg.label), { sticky: true, className: "waypoint-tooltip" });
      }
    }

    for (const marker of tripPlan.markers) {
      points.push([marker.lat, marker.lon]);
      L.marker([marker.lat, marker.lon], {
        icon: stopIcon(marker),
        pane: "trip",
        interactive: true,
        zIndexOffset: marker.kind === "board" ? 450 : 420,
      })
        .bindTooltip(`${marker.kind === "board" ? "Wsiadanie" : "Wysiadanie"}: ${escapeHtml(marker.label)}`, {
          direction: "top",
          offset: [0, -14],
          className: "waypoint-tooltip",
        })
        .addTo(group);
    }

    const emitMarkerContextMenu = (event: L.LeafletMouseEvent) => {
      dispatchContextMenu(event);
    };

    const endpoints: Array<[TripMapPoint | null, "origin" | "destination", string]> = [
      [tripPlan.origin, "origin", "Start"],
      [tripPlan.destination, "destination", "Cel"],
    ];
    for (const [point, kind, text] of endpoints) {
      if (!point) continue;
      points.push([point.lat, point.lon]);
      const isDest = kind === "destination";
      const marker = L.marker([point.lat, point.lon], {
        icon: endpointIcon(kind, text),
        pane: "trip",
        interactive: true,
        draggable: true,
        autoPan: true,
        bubblingMouseEvents: false,
        keyboard: true,
        title: isDest
          ? "Cel podróży: przeciągnij lub kliknij i wskaż nowe miejsce"
          : "Start podróży: przeciągnij lub kliknij i wskaż nowe miejsce",
        zIndexOffset: isDest ? 510 : 500,
      })
        .bindTooltip(
          `${text}: ${escapeHtml(point.label)}<br>Przeciągnij lub kliknij i wskaż nowe miejsce.`,
          {
            direction: "top",
            offset: [0, -14],
            className: "waypoint-tooltip",
          }
        )
        .addTo(group);

      marker.on("contextmenu", emitMarkerContextMenu);
      marker.on("dragstart", () => marker.closeTooltip());

      if (isDest) {
        tripDestinationRef.current = marker;
        marker.getElement()?.setAttribute("data-testid", "trip-destination-marker");
        marker.getElement()?.setAttribute("aria-label", "Cel podróży: kliknij, aby zmienić miejsce");
        marker.on("click", (event: L.LeafletMouseEvent) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          tripDestinationPickRef.current?.();
        });
        marker.on("dragend", () => {
          const position = marker.getLatLng();
          tripDestinationMoveRef.current?.(position.lat, position.lng);
        });
      } else {
        tripOriginRef.current = marker;
        marker.getElement()?.setAttribute("data-testid", "trip-origin-marker");
        marker.getElement()?.setAttribute(
          "aria-label",
          "Start podróży: kliknij, aby zmienić miejsce"
        );
        marker.on("click", (event: L.LeafletMouseEvent) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          tripOriginPickRef.current?.();
        });
        marker.on("dragend", () => {
          const position = marker.getLatLng();
          tripOriginMoveRef.current?.(position.lat, position.lng);
        });
      }
    }

    const fitKey = JSON.stringify([
      tripPlan.origin ? [tripPlan.origin.lat, tripPlan.origin.lon] : null,
      tripPlan.destination ? [tripPlan.destination.lat, tripPlan.destination.lon] : null,
      tripPlan.key,
    ]);
    if (lastTripFitRef.current === fitKey) return;
    lastTripFitRef.current = fitKey;
    if (points.length >= 2) {
      map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: map.getSize().x > 760 ? [360, 90] : [35, 90],
        paddingBottomRight: [60, 80],
        maxZoom: 15,
        animate: true,
      });
    } else if (points.length === 1) {
      const visibleBounds = map.getBounds().pad(-0.08);
      if (!visibleBounds.contains(points[0])) {
        map.setView(points[0], Math.max(map.getZoom(), 15), { animate: true });
      }
    }
  }, [tripPlan, theme]);

  useEffect(() => {
    const originEl = tripOriginRef.current?.getElement();
    originEl?.classList.toggle("trip-origin-editing", tripOriginEditing);
    originEl?.setAttribute("aria-pressed", String(tripOriginEditing));
    const destEl = tripDestinationRef.current?.getElement();
    destEl?.classList.toggle("trip-destination-editing", tripDestinationEditing);
    destEl?.setAttribute("aria-pressed", String(tripDestinationEditing));
  }, [tripPlan, tripOriginEditing, tripDestinationEditing]);

  /* Traffic signal intersections along route */
  useEffect(() => {
    const group = signalGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showTrafficSignals || !trafficSignals.length) return;

    for (const sig of trafficSignals) {
      const icon = L.divIcon({
        className: "pin-wrap",
        html: `<div class="signal-badge" title="Sygnalizacja świetlna"><span class="signal-dot signal-dot--r"></span><span class="signal-dot signal-dot--y"></span><span class="signal-dot signal-dot--g"></span></div>`,
        iconSize: [14, 24],
        iconAnchor: [7, 12],
      });
      const marker = L.marker([sig.lat, sig.lon], {
        icon,
        pane: "signals",
        interactive: true,
        zIndexOffset: 320,
      });
      marker.bindTooltip(
        `Sygnalizacja świetlna (${(sig.routeOffsetMeters / 1000).toFixed(2)} km trasy)`,
        { direction: "top", offset: [0, -10], className: "waypoint-tooltip" }
      );
      marker.addTo(group);
    }
  }, [trafficSignals, showTrafficSignals]);

  /* Bus turn-around spots (only detected for vehicles 12 m and longer) */
  useEffect(() => {
    const group = turnaroundGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showTurnarounds || !turnaroundSpots.length) return;

    const uTurnArrow =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

    for (const spot of turnaroundSpots) {
      const kindLabel =
        spot.kind === "roundabout" ? "rondo" : spot.arms > 4 ? "skrzyżowanie 5-kierunkowe" : "duże skrzyżowanie";
      const icon = L.divIcon({
        className: "pin-wrap",
        html: `<div class="turnaround-badge${spot.kind === "roundabout" ? " turnaround-badge--round" : ""}" title="Miejsce na zawrócenie autobusu">${uTurnArrow}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const marker = L.marker([spot.lat, spot.lon], {
        icon,
        pane: "signals",
        interactive: true,
        zIndexOffset: 260,
      });
      marker.bindTooltip(
        `Miejsce na zawrócenie autobusu — ${kindLabel} (${(spot.routeOffsetMeters / 1000).toFixed(2)} km trasy)`,
        { direction: "top", offset: [0, -10], className: "waypoint-tooltip" }
      );
      marker.addTo(group);
    }
  }, [turnaroundSpots, showTurnarounds]);

  /* Live GPS Wałbrzych buses (reconciled in-place so 10s updates never tear down DOM nodes) */
  useEffect(() => {
    const group = vehicleGroupRef.current;
    if (!group) return;

    const existing = liveBusMarkersRef.current;
    if (!showLiveBuses || !liveBuses.length) {
      group.clearLayers();
      existing.clear();
      liveBusByIdRef.current.clear();
      return;
    }

    const activeIds = new Set<string>();
    liveBusByIdRef.current.clear();

    for (const bus of liveBuses) {
      activeIds.add(bus.vehicleId);
      liveBusByIdRef.current.set(bus.vehicleId, bus);

      const selected = bus.vehicleId === selectedLiveBusId;
      const { html, tooltip } = buildBusMarker(
        bus,
        { kursowka: busLabelKursowka, vehicleNumber: busLabelVehicleNumber },
        selected
      );

      const prev = existing.get(bus.vehicleId);
      if (prev) {
        prev.marker.setLatLng([bus.lat, bus.lon]);
        if (prev.html !== html) {
          prev.marker.setIcon(
            L.divIcon({
              className: "pin-wrap pin-wrap--passive",
              html,
              iconSize: [210, 56],
              iconAnchor: [105, 14],
            })
          );
          prev.html = html;
        }
        if (prev.selected !== selected) {
          prev.marker.setZIndexOffset(selected ? 2000 : 750);
          prev.selected = selected;
        }
        if (prev.tooltip !== tooltip) {
          prev.marker.setTooltipContent(tooltip);
          prev.tooltip = tooltip;
        }
      } else {
        const icon = L.divIcon({
          className: "pin-wrap pin-wrap--passive",
          html,
          iconSize: [210, 56],
          iconAnchor: [105, 14],
        });
        const marker = L.marker([bus.lat, bus.lon], {
          icon,
          pane: "vehicles",
          zIndexOffset: selected ? 2000 : 750,
          riseOnHover: true,
        });
        marker.bindTooltip(tooltip, {
          direction: "top",
          offset: [0, -12],
          className: "waypoint-tooltip live-bus-tooltip",
        });
        const id = bus.vehicleId;
        marker.on("click", (event: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(event.originalEvent);
          const current = liveBusByIdRef.current.get(id);
          if (current) liveBusClickRef.current?.(current);
        });
        marker.addTo(group);
        existing.set(bus.vehicleId, { marker, html, tooltip, selected });
      }
    }

    for (const [id, entry] of existing) {
      if (!activeIds.has(id)) {
        group.removeLayer(entry.marker);
        existing.delete(id);
      }
    }
  }, [liveBuses, showLiveBuses, selectedLiveBusId, busLabelKursowka, busLabelVehicleNumber]);

  /* Draggable waypoint pins */
  useEffect(() => {
    const group = markerGroupRef.current;
    if (!group) return;
    group.clearLayers();
    const assigned = waypoints.filter(isWaypointSet);
    if (draftMode && assigned.length >= 2) {
      L.polyline(
        assigned.map((point) => [point.lat, point.lon] as [number, number]),
        { color: "#5f866e", weight: 2, dashArray: "5 7", interactive: false }
      ).addTo(group);
    }

    waypoints.forEach((waypoint, index) => {
      if (!isWaypointSet(waypoint)) return;
      const isStart = index === 0;
      const isEnd = index === waypoints.length - 1;
      const label = isStart ? "A" : isEnd ? "B" : String(index);
      const modifier = isStart ? "start" : isEnd ? "end" : "via";
      const icon = L.divIcon({
        className: "pin-wrap",
        html: `<div class="pin pin--${modifier}" aria-label="${escapeHtml(waypoint.short)}">${label}</div>`,
        iconSize: isStart || isEnd ? [32, 32] : [26, 26],
        iconAnchor: isStart || isEnd ? [16, 16] : [13, 13],
      });
      const marker = L.marker([waypoint.lat, waypoint.lon], {
        icon,
        draggable: true,
        autoPan: true,
        riseOnHover: true,
        zIndexOffset: isStart || isEnd ? 600 : 400,
        title: waypoint.label,
      });
      marker.bindTooltip(escapeHtml(waypoint.short), {
        permanent: isStart || isEnd || waypoints.length <= 6,
        direction: "bottom",
        offset: [0, isStart || isEnd ? 18 : 14],
        className: "waypoint-tooltip",
      });
      marker.on("dragend", () => {
        const position = marker.getLatLng();
        dragRef.current(waypoint.id, position.lat, position.lng);
      });
      marker.addTo(group);
    });
  }, [waypoints, draftMode]);

  /* Bus stops layer */
  useEffect(() => {
    const group = stopGroupRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();
    stopMarkersRef.current.clear();
    stopStateRef.current.clear();
    if (!busStops.length) return;

    let cancelled = false;
    let chunk = 0;
    const CHUNK_SIZE = 90;

    const refreshLabels = () => {
      const showNames = map.getZoom() >= 16;
      const area = map.getBounds().pad(0.05);
      stopMarkersRef.current.forEach((marker) => {
        if (showNames && area.contains(marker.getLatLng())) marker.openTooltip();
        else marker.closeTooltip();
      });
    };

    const drawChunk = () => {
      if (cancelled) return;
      const slice = busStops.slice(chunk * CHUNK_SIZE, chunk * CHUNK_SIZE + CHUNK_SIZE);
      for (const stop of slice) {
        const state = computeStopVisualState(stop, selectedStopId, nearRouteIds, usedStopKeys);
        const marker = L.marker([stop.lat, stop.lon], {
          icon: createStopDivIcon(stop.id, state),
          pane: "stops",
          title: stop.name,
          keyboard: false,
          riseOnHover: true,
        });
        marker.bindTooltip(escapeHtml(stopDisplayName(stop)), {
          direction: "right",
          offset: [12, 0],
          className: "stop-name-label",
          opacity: 1,
        });
        marker.on("click", (event: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(event.originalEvent);
          stopClickRef.current?.(stop);
        });
        marker.on("contextmenu", (event: L.LeafletMouseEvent) => {
          dispatchContextMenu(event, stop.lat, stop.lon, stop);
        });
        marker.addTo(group);
        stopMarkersRef.current.set(stop.id, marker);
        stopStateRef.current.set(stop.id, state);
      }
      chunk += 1;
      if (chunk * CHUNK_SIZE < busStops.length) requestAnimationFrame(drawChunk);
      else refreshLabels();
    };

    map.on("zoomend moveend", refreshLabels);
    drawChunk();
    return () => {
      cancelled = true;
      map.off("zoomend moveend", refreshLabels);
    };
  }, [busStops]);

  useEffect(() => {
    if (!busStops.length) return;
    for (const stop of busStops) {
      const marker = stopMarkersRef.current.get(stop.id);
      if (!marker) continue;
      const state = computeStopVisualState(stop, selectedStopId, nearRouteIds, usedStopKeys);
      if (stopStateRef.current.get(stop.id) === state) continue;
      stopStateRef.current.set(stop.id, state);
      marker.setIcon(createStopDivIcon(stop.id, state));
      marker.setZIndexOffset(state.includes("on") ? 900 : state.includes("used") ? 400 : 0);
    }
  }, [selectedStopId, nearRouteIds, usedStopKeys, busStops]);

  /* Navigation vehicle marker */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!navCoord) {
      if (navMarkerRef.current) {
        map.removeLayer(navMarkerRef.current);
        navMarkerRef.current = null;
      }
      return;
    }
    const icon = L.divIcon({
      className: "pin-wrap",
      html: `<div class="nav-vehicle">${vehicleSvg}</div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
    if (!navMarkerRef.current) {
      navMarkerRef.current = L.marker(navCoord, {
        icon,
        zIndexOffset: 1200,
        interactive: false,
      }).addTo(map);
    } else {
      navMarkerRef.current.setLatLng(navCoord);
    }
    if (followNav) {
      map.panInside(navCoord, {
        paddingTopLeft: [90, 120],
        paddingBottomRight: [90, 170],
        animate: true,
        duration: 0.45,
      });
    }
  }, [navCoord, followNav]);

  /* Kropka lokalizacji użytkownika + okrąg dokładności */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLocation) {
      userMarkerRef.current?.remove();
      userCircleRef.current?.remove();
      userMarkerRef.current = null;
      userCircleRef.current = null;
      return;
    }
    const latlng: [number, number] = [userLocation.lat, userLocation.lon];
    const radius = Math.max(userLocation.accuracy, 1);
    if (!userCircleRef.current) {
      userCircleRef.current = L.circle(latlng, {
        radius,
        pane: "user",
        interactive: false,
        color: "#1a73e8",
        weight: 1,
        opacity: 0.45,
        fillColor: "#1a73e8",
        fillOpacity: 0.12,
      }).addTo(map);
    } else {
      userCircleRef.current.setLatLng(latlng).setRadius(radius);
    }
    if (!userMarkerRef.current) {
      userMarkerRef.current = L.marker(latlng, {
        pane: "user",
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: "user-location-wrap",
          html: '<div class="user-location" data-testid="user-location-marker"><span class="user-location-pulse"></span><span class="user-location-heading">' +
            '<svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true"><path d="M23 1 31 15H15L23 1Z" fill="currentColor"/></svg></span><span class="user-location-dot"></span></div>',
          iconSize: [46, 46],
          iconAnchor: [23, 23],
        }),
      }).addTo(map);
    } else {
      userMarkerRef.current.setLatLng(latlng);
    }
    const element = userMarkerRef.current.getElement()?.querySelector<HTMLElement>(".user-location");
    if (element) {
      const heading = userLocation.heading;
      element.classList.toggle("user-location--heading", heading !== null);
      element.style.setProperty("--user-heading", `${heading ?? 0}deg`);
    }
  }, [userLocation]);

  /* Podążanie za użytkownikiem w trakcie ruchu */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followUser || !userLocation || flyingRef.current) return;
    map.panTo([userLocation.lat, userLocation.lon], { animate: true, duration: 0.5 });
  }, [userLocation, followUser]);

  /* Wycentrowanie na użytkowniku (przycisk / pierwszy odczyt) */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userLocation || centerUserNonce === lastCenterNonceRef.current) return;
    lastCenterNonceRef.current = centerUserNonce;
    flyingRef.current = true;
    const done = () => {
      flyingRef.current = false;
    };
    map.once("moveend", done);
    // Zabezpieczenie, gdyby ruch się nie odbył (mapa już wycentrowana).
    window.setTimeout(done, 1500);
    map.flyTo([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 15), {
      duration: 0.8,
    });
  }, [centerUserNonce, userLocation]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    userPanRef.current?.();
    mapRef.current.flyTo([focus.lat, focus.lon], focus.zoom ?? 14, { duration: 0.9 });
  }, [focus]);

  const tileTone = mapStyle === "satellite" ? "satellite" : theme;

  return (
    <div className="relative h-full w-full select-none overflow-hidden">
      <div
        ref={containerRef}
        className="h-full w-full select-none outline-none"
        style={{ cursor: pickMode ? "crosshair" : undefined }}
        role="application"
        aria-label="Interaktywna mapa trasy"
      />
      {mapStyle === "satellite" && (
        <div className="pointer-events-none absolute inset-0 bg-[#06110c]/20" aria-hidden="true" />
      )}
      <div
        className="pointer-events-none absolute inset-0 shadow-[inset_0_0_90px_rgba(7,35,24,0.1)] dark:shadow-[inset_0_0_48px_rgba(0,0,0,0.12)]"
        aria-hidden="true"
        data-tone={tileTone}
      />
    </div>
  );
});

export default MapView;

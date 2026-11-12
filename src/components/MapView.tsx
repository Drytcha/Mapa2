import "leaflet/dist/leaflet.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import L from "leaflet";
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

export interface MapHandle {
  fitRoute: () => void;
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
  navCoord?: [number, number] | null;
  followNav?: boolean;
  focus?: { lat: number; lon: number; zoom?: number; nonce: number } | null;
  onLineClick: (point: [number, number]) => void;
  onMarkerDrag: (id: string, lat: number, lon: number) => void;
  onMapClick: (lat: number, lon: number) => void;
  onMapContextMenu: (lat: number, lon: number, clientX: number, clientY: number) => void;
}

const vehicleSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.6 3.9 21l8.1-4.7 8.1 4.7L12 2.6Z" fill="currentColor"/></svg>`;

const busGlyph = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 17V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11"/><path d="M4 11h16"/><path d="M4 17h16"/><circle cx="7.5" cy="19.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="19.5" r="1.2" fill="currentColor" stroke="none"/></svg>`;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ] as string
  );

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
    navCoord,
    followNav = false,
    focus,
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
  useEffect(() => {
    pickModeRef.current = pickMode;
    stopClickRef.current = onBusStopClick;
    liveBusClickRef.current = onLiveBusClick;
    lineClickRef.current = onLineClick;
    dragRef.current = onMarkerDrag;
    mapClickRef.current = onMapClick;
    contextMenuRef.current = onMapContextMenu;
    routeRef.current = route;
  });

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

  useImperativeHandle(ref, () => ({
    fitRoute: fitBounds,
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    centerOn: (lat, lon, zoom = 13) =>
      mapRef.current?.flyTo([lat, lon], zoom, { duration: 0.8 }),
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
    mapRef.current = map;

    const labelPane = map.createPane("labels");
    labelPane.style.zIndex = "250";
    labelPane.style.pointerEvents = "none";

    const kursowkaPane = map.createPane("kursowka");
    kursowkaPane.style.zIndex = "510";

    const stopPane = map.createPane("stops");
    stopPane.style.zIndex = "540";

    const signalPane = map.createPane("signals");
    signalPane.style.zIndex = "550";

    const vehiclePane = map.createPane("vehicles");
    vehiclePane.style.zIndex = "680";

    routeGroupRef.current = L.layerGroup().addTo(map);
    kursowkaGroupRef.current = L.layerGroup().addTo(map);
    stopGroupRef.current = L.layerGroup().addTo(map);
    signalGroupRef.current = L.layerGroup().addTo(map);
    turnaroundGroupRef.current = L.layerGroup().addTo(map);
    vehicleGroupRef.current = L.layerGroup().addTo(map);
    markerGroupRef.current = L.layerGroup().addTo(map);

    map.on("click", (event: L.LeafletMouseEvent) => {
      mapClickRef.current(event.latlng.lat, event.latlng.lng);
    });
    map.on("contextmenu", (event: L.LeafletMouseEvent) => {
      const original = event.originalEvent as MouseEvent | undefined;
      if (!original) return;
      L.DomEvent.stop(original);
      const rect = container.getBoundingClientRect();
      const clientX =
        original.clientX === 0 && original.clientY === 0 && event.containerPoint
          ? rect.left + event.containerPoint.x
          : original.clientX;
      const clientY =
        original.clientX === 0 && original.clientY === 0 && event.containerPoint
          ? rect.top + event.containerPoint.y
          : original.clientY;
      contextMenuRef.current(event.latlng.lat, event.latlng.lng, clientX, clientY);
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
      signalGroupRef.current = null;
      turnaroundGroupRef.current = null;
      vehicleGroupRef.current = null;
      markerGroupRef.current = null;
      stopGroupRef.current = null;
      navMarkerRef.current = null;
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

  /* GTFS Kursówka shape overlay */
  useEffect(() => {
    const map = mapRef.current;
    const group = kursowkaGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (!kursowkaOverlay || !kursowkaOverlay.polylines.length) return;

    const allPts: [number, number][] = [];
    for (const line of kursowkaOverlay.polylines) {
      if (line.length < 2) continue;
      allPts.push(...line);
      L.polyline(line, {
        color: "#ffffff",
        weight: 8,
        opacity: 0.85,
        pane: "kursowka",
        interactive: false,
      }).addTo(group);
      L.polyline(line, {
        color: kursowkaOverlay.color || "#0d4f3b",
        weight: 4.5,
        opacity: 0.95,
        dashArray: "9 6",
        pane: "kursowka",
        interactive: false,
      }).addTo(group);
    }
    if (allPts.length >= 2) {
      map.fitBounds(L.latLngBounds(allPts), {
        padding: [56, 56],
        maxZoom: 15,
        animate: true,
      });
    }
  }, [kursowkaOverlay]);

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

    const stopState = (stop: BusStop) =>
      [
        stop.id === selectedStopId ? "on" : "",
        nearRouteIds?.has(stop.id) ? "route" : "",
        usedStopKeys?.has(`${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`) ? "used" : "",
        stop.source === "osm" ? "osm" : "",
      ].join("|");

    const stopIcon = (id: string, state: string) =>
      L.divIcon({
        className: "pin-wrap",
        html: `<span class="bus-stop${state.includes("on") ? " bus-stop--on" : ""}${
          state.includes("route") ? " bus-stop--route" : ""
        }${state.includes("used") ? " bus-stop--used" : ""}${state.includes("osm") ? " bus-stop--osm" : ""}" data-stop-id="${escapeHtml(id)}" aria-hidden="true">${busGlyph}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

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
        const state = stopState(stop);
        const marker = L.marker([stop.lat, stop.lon], {
          icon: stopIcon(stop.id, state),
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
      const state = [
        stop.id === selectedStopId ? "on" : "",
        nearRouteIds?.has(stop.id) ? "route" : "",
        usedStopKeys?.has(`${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`) ? "used" : "",
        stop.source === "osm" ? "osm" : "",
      ].join("|");
      if (stopStateRef.current.get(stop.id) === state) continue;
      stopStateRef.current.set(stop.id, state);
      marker.setIcon(
        L.divIcon({
          className: "pin-wrap",
          html: `<span class="bus-stop${state.includes("on") ? " bus-stop--on" : ""}${
            state.includes("route") ? " bus-stop--route" : ""
          }${state.includes("used") ? " bus-stop--used" : ""}${state.includes("osm") ? " bus-stop--osm" : ""}" data-stop-id="${escapeHtml(stop.id)}" aria-hidden="true">${busGlyph}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        })
      );
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

  useEffect(() => {
    if (!focus || !mapRef.current) return;
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

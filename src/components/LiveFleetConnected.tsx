import type { ComponentProps, ReactNode } from "react";
import {
  useLiveBusById,
  useLiveBusCount,
  useLiveLoading,
  useLiveTraffic,
  useLiveVehicles,
  useVisibleLiveBuses,
} from "@/lib/liveFleetStore";
import type { LiveBusVehicle, WalbrzychOperatorKey } from "@/lib/types";
import { LiveBusCard, LiveFleetControl } from "./MapOverlays";
import TopBar from "./TopBar";

type TopBarBaseProps = Omit<ComponentProps<typeof TopBar>, "liveBusCount">;

/** Pasek górny reaguje wyłącznie na zmianę liczby wozów (nie na każdy tick GPS). */
export function ConnectedTopBar(props: TopBarBaseProps) {
  const liveBusCount = useLiveBusCount();
  return <TopBar {...props} liveBusCount={liveBusCount} />;
}

type LiveFleetControlBaseProps = Omit<
  ComponentProps<typeof LiveFleetControl>,
  "liveVehicles" | "liveTraffic" | "liveLoading"
>;

/** Kontrolka floty na mapie subskrybuje store floty niezależnie od głównego drzewa. */
export function ConnectedLiveFleetControl(props: LiveFleetControlBaseProps) {
  const liveVehicles = useLiveVehicles();
  const liveTraffic = useLiveTraffic();
  const liveLoading = useLiveLoading();
  return (
    <LiveFleetControl
      {...props}
      liveVehicles={liveVehicles}
      liveTraffic={liveTraffic}
      liveLoading={liveLoading}
    />
  );
}

interface ConnectedLiveBusCardProps {
  isPlanner: boolean;
  initialBus: LiveBusVehicle;
  onClose: () => void;
  onOpenKursowka: (code: string) => void;
  onSetOperator: (vehicleId: string, op: WalbrzychOperatorKey | null) => void;
  onCenterBus: (bus: LiveBusVehicle) => void;
}

/** Karta wybranego autobusu re-renderuje się tylko, gdy poruszy się ten jeden wóz. */
export function ConnectedLiveBusCard({
  isPlanner,
  initialBus,
  onClose,
  onOpenKursowka,
  onSetOperator,
  onCenterBus,
}: ConnectedLiveBusCardProps) {
  const bus = useLiveBusById(initialBus.vehicleId, initialBus) ?? initialBus;
  return (
    <LiveBusCard
      isPlanner={isPlanner}
      bus={bus}
      onClose={onClose}
      onOpenKursowka={onOpenKursowka}
      onSetOperator={onSetOperator}
      onCenter={() => onCenterBus(bus)}
    />
  );
}

/** Render-prop do przekazania przefiltrowanej listy widocznych autobusów (np. dla leniwego MapView). */
export function WithVisibleLiveBuses({
  isPlanner,
  operatorFilter,
  children,
}: {
  isPlanner: boolean;
  operatorFilter: "all" | WalbrzychOperatorKey;
  children: (visibleBuses: LiveBusVehicle[]) => ReactNode;
}) {
  const visible = useVisibleLiveBuses(isPlanner, operatorFilter);
  return <>{children(visible)}</>;
}

/** Render-prop do przekazania pełnej listy wozów do leniwie ładowanych paneli. */
export function WithLiveVehicles({
  children,
}: {
  children: (vehicles: LiveBusVehicle[]) => ReactNode;
}) {
  const vehicles = useLiveVehicles();
  return <>{children(vehicles)}</>;
}

/** Etykieta liczby widocznych autobusów GPS na mobilnym przycisku. */
export function VisibleLiveBusCountLabel({
  isPlanner,
  operatorFilter,
}: {
  isPlanner: boolean;
  operatorFilter: "all" | WalbrzychOperatorKey;
}) {
  const visible = useVisibleLiveBuses(isPlanner, operatorFilter);
  return <>GPS autobusów ({visible.length})</>;
}

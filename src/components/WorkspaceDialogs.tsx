import { lazy, Suspense } from "react";
import type { CustomGtfsResumeTarget } from "./CustomGtfsBuilderDialog";
import type { CustomGtfsMapSession } from "./CustomGtfsMapDrawToolbar";
import type { KursowkaShapeOverlay } from "./MapView";
import {
  FleetDialog,
  PlanistLoginDialog,
  ReportDialog,
  SettingsDialog,
  StepsDrawer,
} from "./Modals";
import type {
  BrigadeInfo,
  ProfileMetrics,
  RouteData,
  RouteStep,
  VehicleId,
  VehicleProfile,
  Waypoint,
} from "@/lib/types";

const ScheduleDiffDialog = lazy(() => import("./ScheduleDiffDialog"));
const RouteAuditDialog = lazy(() => import("./RouteAuditDialog"));
const CustomGtfsBuilderDialog = lazy(() => import("./CustomGtfsBuilderDialog"));
const PdfExportDialog = lazy(() => import("./PdfExportDialog"));

export interface WorkspaceDialogsProps {
  isPlanner: boolean;
  plannerLoginOpen: boolean;
  onClosePlannerLogin: () => void;
  onSuccessPlannerLogin: () => void;
  scheduleDiffOpen: boolean;
  scheduleDiffPreset: "default" | "ns-nh";
  onCloseScheduleDiff: () => void;
  routeAuditOpen: boolean;
  onCloseRouteAudit: () => void;
  onFixInEditor: (lineShort: string, variantKey: string) => void;
  onShowOverlayOnMap: (overlay: KursowkaShapeOverlay) => void;
  customGtfsBuilderOpen: boolean;
  onCloseCustomGtfsBuilder: () => void;
  onStartCustomGtfsMapSession: (session: CustomGtfsMapSession) => void;
  customGtfsResumeTarget: CustomGtfsResumeTarget | null;
  stepsOpen: boolean;
  onCloseSteps: () => void;
  navigationRoute: RouteData;
  activeRoute: RouteData;
  waypoints: Waypoint[];
  metrics: ProfileMetrics;
  comparisons: ProfileMetrics[];
  vehicle: VehicleId;
  brigade: BrigadeInfo;
  fleet: VehicleProfile[];
  onFocusStep: (step: RouteStep) => void;
  onStartNavigation: () => void;
  fleetOpen: boolean;
  onCloseFleet: () => void;
  onVehicleChange: (next: VehicleId) => void;
  onFleetChange: (next: VehicleProfile[]) => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  reportOpen: boolean;
  onCloseReport: () => void;
  onOpenPdf: () => void;
  exportReady: boolean;
  pdfOpen: boolean;
  onClosePdf: () => void;
  showToast: (message: string) => void;
}

export default function WorkspaceDialogs({
  isPlanner,
  plannerLoginOpen,
  onClosePlannerLogin,
  onSuccessPlannerLogin,
  scheduleDiffOpen,
  scheduleDiffPreset,
  onCloseScheduleDiff,
  routeAuditOpen,
  onCloseRouteAudit,
  onFixInEditor,
  onShowOverlayOnMap,
  customGtfsBuilderOpen,
  onCloseCustomGtfsBuilder,
  onStartCustomGtfsMapSession,
  customGtfsResumeTarget,
  stepsOpen,
  onCloseSteps,
  navigationRoute,
  activeRoute,
  waypoints,
  metrics,
  comparisons,
  vehicle,
  brigade,
  fleet,
  onFocusStep,
  onStartNavigation,
  fleetOpen,
  onCloseFleet,
  onVehicleChange,
  onFleetChange,
  settingsOpen,
  onCloseSettings,
  reportOpen,
  onCloseReport,
  onOpenPdf,
  exportReady,
  pdfOpen,
  onClosePdf,
  showToast,
}: WorkspaceDialogsProps) {
  return (
    <>
      {plannerLoginOpen && (
        <PlanistLoginDialog
          open={plannerLoginOpen}
          onClose={onClosePlannerLogin}
          onSuccess={onSuccessPlannerLogin}
        />
      )}

      {isPlanner && scheduleDiffOpen && (
        <Suspense fallback={null}>
          <ScheduleDiffDialog
            open={scheduleDiffOpen}
            initialPreset={scheduleDiffPreset}
            onClose={onCloseScheduleDiff}
            onToast={showToast}
          />
        </Suspense>
      )}

      {isPlanner && routeAuditOpen && (
        <Suspense fallback={null}>
          <RouteAuditDialog
            open={routeAuditOpen}
            onClose={onCloseRouteAudit}
            onFixInEditor={onFixInEditor}
            onShowOnMap={onShowOverlayOnMap}
            onToast={showToast}
          />
        </Suspense>
      )}

      {isPlanner && customGtfsBuilderOpen && (
        <Suspense fallback={null}>
          <CustomGtfsBuilderDialog
            open={customGtfsBuilderOpen}
            onClose={onCloseCustomGtfsBuilder}
            onShowOnMap={onShowOverlayOnMap}
            onStartMapSession={onStartCustomGtfsMapSession}
            resumeTarget={customGtfsResumeTarget}
            onToast={showToast}
          />
        </Suspense>
      )}

      {stepsOpen && (
        <StepsDrawer
          open={stepsOpen}
          onClose={onCloseSteps}
          route={navigationRoute}
          waypoints={waypoints}
          metrics={metrics}
          vehicle={vehicle}
          onFocusStep={onFocusStep}
          onStartNavigation={onStartNavigation}
        />
      )}

      {fleetOpen && (
        <FleetDialog
          open={fleetOpen}
          onClose={onCloseFleet}
          fleet={fleet}
          activeId={vehicle}
          onSelect={onVehicleChange}
          onChange={onFleetChange}
        />
      )}

      {isPlanner && settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onClose={onCloseSettings}
          engine={
            activeRoute.engine === "osrm"
              ? "OSRM (bez klucza)"
              : "Schemat demonstracyjny"
          }
        />
      )}

      {reportOpen && (
        <ReportDialog
          open={reportOpen}
          onClose={onCloseReport}
          waypoints={waypoints}
          route={activeRoute}
          metrics={comparisons}
          activeVehicle={vehicle}
          brigade={brigade}
          onOpenPdf={onOpenPdf}
          pdfDisabled={!exportReady}
        />
      )}

      {pdfOpen && (
        <Suspense fallback={null}>
          <PdfExportDialog
            open={pdfOpen}
            onClose={onClosePdf}
            route={navigationRoute}
            waypoints={waypoints}
            metrics={metrics}
            vehicle={vehicle}
            brigade={brigade}
            routeReady={exportReady}
          />
        </Suspense>
      )}
    </>
  );
}

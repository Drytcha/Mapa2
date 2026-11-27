import { useEffect, useRef, useState } from "react";
import {
  BusFront,
  ChevronDown,
  FileDown,
  FileSpreadsheet,
  ListOrdered,
  Loader2,
  Menu,
  Moon,
  Radio,
  Route as RouteIcon,
  Ruler,
  Settings2,
  Sun,
  Truck,
  Waypoints,
  X,
} from "lucide-react";
import type { AppRole, RouteData, ThemeMode } from "@/lib/types";
import { readableEngine } from "@/lib/geo";
import { cn } from "@/utils/cn";
import { IconButton, Logo } from "./UI";
import { PlanistLoginDialog } from "./Modals";

interface TopBarProps {
  route: RouteData;
  isRouting: boolean;
  routeReady: boolean;
  role: AppRole;
  onRoleChange: (role: AppRole) => void;
  theme: ThemeMode;
  liveBusCount: number;
  showLiveBuses: boolean;
  kursowkiOpen: boolean;
  linesOpen: boolean;
  onToggleLiveBuses: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenSteps: () => void;
  onOpenFleet: () => void;
  onOpenReport: () => void;
  onOpenKursowki: () => void;
  onOpenLines: () => void;
  onOpenPlanner: () => void;
  onOpenPdf: () => void;
  pdfDisabled: boolean;
}

const NAV = [
  { id: "planner", label: "Planer", icon: RouteIcon },
  { id: "kursowki", label: "Kursówki", icon: BusFront },
  { id: "lines", label: "Linie", icon: Waypoints },
  { id: "nav", label: "Nawigacja", icon: ListOrdered },
  { id: "fleet", label: "Flota", icon: Truck },
  { id: "report", label: "Raporty", icon: FileSpreadsheet },
] as const;

export default function TopBar({
  route,
  isRouting,
  routeReady,
  role,
  onRoleChange,
  theme,
  liveBusCount,
  showLiveBuses,
  kursowkiOpen,
  linesOpen,
  onToggleLiveBuses,
  onToggleTheme,
  onOpenSettings,
  onOpenSteps,
  onOpenFleet,
  onOpenReport,
  onOpenKursowki,
  onOpenLines,
  onOpenPlanner,
  onOpenPdf,
  pdfDisabled,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);
  const live = routeReady;
  const isPlanner = role === "planner";

  const action = (id: (typeof NAV)[number]["id"]) => {
    if (id === "planner") onOpenPlanner();
    if (id === "kursowki") onOpenKursowki();
    if (id === "lines") onOpenLines();
    if (id === "nav") onOpenSteps();
    if (id === "fleet") onOpenFleet();
    if (id === "report") onOpenReport();
  };

  const visibleNav = NAV.filter(
    (item) => isPlanner || item.id === "kursowki" || item.id === "lines"
  );

  // A direct link opens the existing planner login without advertising it in the user UI.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("planista") !== "1") return;
    url.searchParams.delete("planista");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (!isPlanner) setLoginOpen(true);
  }, [isPlanner]);

  useEffect(() => {
    if (!roleMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (!roleMenuRef.current?.contains(event.target as Node)) setRoleMenuOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRoleMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", esc);
    };
  }, [roleMenuOpen]);

  return (
    <header className="relative z-[1000] flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 sm:px-3.5 md:h-12">
      <div className="flex min-w-0 items-center gap-2.5 lg:w-[403px]">
        <Logo showName={isPlanner} />
        <span className="hidden rounded-full border border-line bg-raised px-1.5 py-[2px] text-[7px] font-extrabold uppercase tracking-[0.1em] text-mute 2xl:inline">
          Wałbrzych GTFS
        </span>
      </div>

      <nav
        aria-label="Widoki aplikacji"
        className="hidden flex-1 items-center justify-center gap-0.5 md:flex"
      >
        {visibleNav.map((item) => {
          const Icon = item.icon;
          const active =
            (item.id === "planner" && !kursowkiOpen && !linesOpen) ||
            (item.id === "kursowki" && kursowkiOpen) ||
            (item.id === "lines" && linesOpen);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => action(item.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 text-[9.5px] font-bold transition-all",
                active
                  ? "bg-brand text-on-brand shadow-[0_2px_8px_rgba(13,79,59,0.16)]"
                  : "text-mute hover:bg-raised hover:text-ink"
              )}
            >
              <Icon
                className={cn(
                  "h-3 w-3",
                  active ? "text-on-brand" : "text-mute group-hover:text-ink-soft"
                )}
                strokeWidth={2.1}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={onToggleLiveBuses}
          title="Pokaż / ukryj autobusy GPS Wałbrzych (MZUK, ŚKA)"
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border px-2 text-[8.5px] font-bold transition-colors",
            showLiveBuses
              ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              : "border-line bg-raised text-mute hover:text-ink"
          )}
        >
          <Radio
            className={cn("h-2.5 w-2.5", showLiveBuses && liveBusCount > 0 && "animate-pulse")}
          />
          <span className="hidden sm:inline">GPS</span>
          <span className="metric">{liveBusCount}</span>
        </button>

        {isPlanner && (
          <span
            className="hidden h-7 items-center gap-1.5 rounded-full border border-line bg-raised px-2 text-[8px] font-bold text-ink-soft xl:flex"
            title={`Silnik routingu: ${readableEngine(route.engine)}`}
          >
            {isRouting ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin text-mute" />
            ) : (
              <span
                className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500" : "bg-warning")}
              />
            )}
            <span className="text-mute">Routing</span>
            {isRouting ? "przeliczanie" : live ? "gotowy" : "oczekuje"}
          </span>
        )}

        {isPlanner && (
          <button
            type="button"
            onClick={onOpenPdf}
            disabled={pdfDisabled}
            aria-label="Eksport trasy do PDF"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[10px] font-bold text-on-brand transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">PDF</span>
          </button>
        )}
        {isPlanner && (
          <IconButton label="Darmowe źródła i informacje" onClick={onOpenSettings}>
            <Settings2 className="h-3.5 w-3.5" />
          </IconButton>
        )}

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "light" ? "Włącz ciemny motyw" : "Włącz jasny motyw"}
          title={theme === "light" ? "Ciemny motyw" : "Jasny motyw"}
          className="flex h-7 w-[46px] items-center rounded-lg border border-line bg-raised p-[2px] transition-colors hover:border-line-strong"
        >
          <span
            className={cn(
              "grid h-[22px] flex-1 place-items-center rounded-[5px] transition-all",
              theme === "light" ? "bg-surface text-ink shadow-sm" : "text-mute"
            )}
          >
            <Sun className="h-3 w-3" strokeWidth={2} />
          </span>
          <span
            className={cn(
              "grid h-[22px] flex-1 place-items-center rounded-[5px] transition-all",
              theme === "dark" ? "bg-surface text-ink shadow-sm" : "text-mute"
            )}
          >
            <Moon className="h-3 w-3" strokeWidth={2} />
          </span>
        </button>

        <span className="mx-0.5 hidden h-5 w-px bg-line sm:block" />

        {isPlanner && (
          <div className="relative flex items-center" ref={roleMenuRef}>
            <button
              type="button"
              onClick={() => setRoleMenuOpen((current) => !current)}
              aria-haspopup="menu"
              aria-expanded={roleMenuOpen}
              title="Profil planisty"
              className="flex items-center gap-2 rounded-[10px] border border-line bg-raised p-[3px] pr-1.5 transition-colors hover:border-line-strong"
            >
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-brand text-on-brand">
                <Ruler className="h-3.5 w-3.5" />
              </span>
              <span className="hidden text-left leading-none 2xl:block">
                <span className="block text-[9.5px] font-extrabold text-ink">Planista</span>
                <span className="mt-0.5 block text-[7.5px] font-semibold text-mute">Pełny planer tras</span>
              </span>
              <ChevronDown className="hidden h-3 w-3 text-mute 2xl:block" />
            </button>
            {roleMenuOpen && (
              <div role="menu" aria-label="Profil planisty" className="absolute right-0 top-[calc(100%+6px)] z-[1100] w-[200px] rounded-xl border border-line bg-surface p-1 shadow-[0_20px_55px_rgba(0,0,0,0.24)]">
                <button type="button" role="menuitem" onClick={() => {
                  setRoleMenuOpen(false);
                  onRoleChange("traveler");
                }} className="w-full rounded-lg px-3 py-2 text-left text-[10px] font-bold text-ink hover:bg-raised">
                  Wyloguj · widok użytkownika
                </button>
              </div>
            )}
          </div>
        )}
        <PlanistLoginDialog
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginOpen(false);
            onRoleChange("planner");
          }}
        />

        <div className="relative md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
            aria-label="Menu aplikacji"
            className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-ink-soft"
          >
            {menuOpen ? <X className="h-3.5 w-3.5" /> : <Menu className="h-3.5 w-3.5" />}
          </button>
          {menuOpen && (
          <div className="absolute right-0 top-10 w-[235px] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-[0_20px_55px_rgba(0,0,0,0.24)] animate-fade-in">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    action(item.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[10px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
                >
                  <Icon className="h-3.5 w-3.5 text-brand-ink" />
                  {item.id === "kursowki"
                    ? "Kursówki Wałbrzych (GTFS)"
                    : item.id === "lines"
                      ? "Linie i trasy"
                    : item.id === "nav"
                      ? "Instrukcje nawigacji"
                      : item.id === "fleet"
                        ? "Flota i przepisy"
                        : item.id === "report"
                          ? "Raport, PDF i CSV"
                          : "Planer trasy"}
                </button>
              );
            })}
              {isPlanner && (
                <>
                  <div className="my-1 h-px bg-line" />
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSettings();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[10px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
                  >
                    <Settings2 className="h-3.5 w-3.5 text-brand-ink" />
                    Darmowe źródła i informacje
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

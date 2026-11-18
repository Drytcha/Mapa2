import { MANUAL_TRANSIT_EXEMPT_IDS } from "@/config/transitExemptions";
import { foldPolish } from "@/lib/core/text";

export type TransitExemptSource = "osm-tag" | "osm-note" | "manual";

export interface TransitExemption {
  exempt: boolean;
  source: TransitExemptSource | null;
  /** Cytat tagu lub opisu, z którego wynika wyjątek. */
  evidence: string | null;
}

const NONE: TransitExemption = { exempt: false, source: null, evidence: null };
const fold = foldPolish;

const AUDIENCE =
  "\\b(?:komunikacj[a-z]*\\s+miejsk[a-z]*|autobus[a-z]*|zdkium|zdk|mzuk|mpk|transport[a-z]*\\s+publiczn[a-z]*|pojazd[a-z]*\\s+komunikacji|bus|buses|psv|public\\s+transport)\\b";

const TEXT_PATTERNS = [
  new RegExp(`nie\\s+dotyczy[^.;|]{0,80}?${AUDIENCE}`),
  new RegExp(`(?:z|za)\\s+wyjatkiem[^.;|]{0,80}?${AUDIENCE}`),
  new RegExp(`wyjatek[^.;|]{0,40}?${AUDIENCE}`),
  new RegExp(`oprocz[^.;|]{0,60}?${AUDIENCE}`),
  new RegExp(`does\\s+not\\s+apply[^.;|]{0,60}?${AUDIENCE}`),
  new RegExp(`except(?:\\s+for)?[^.;|]{0,30}?${AUDIENCE}`),
];

/** Klucze, w których ludzie wpisują treść znaku lub tabliczki. */
const TEXT_KEY = /(note|description|inscription|comment|supplementary|traffic_sign|sign)/;

const BUS_CONDITION = /\b(bus|psv|public_transport)\b/;
const EXEMPT_VALUES = /^(none|no|unlimited|yes|designated|permissive)$/;
const LIMIT_KEY =
  /^(max(weight|height|axleload|length|width)|access|motor_vehicle|vehicle|hgv)(:[a-z_]+)?(:conditional)?$/;

/** `none @ (bus)` / `yes @ psv` — wartość znosząca limit dla autobusów. */
function conditionalExemptsBus(value: string): boolean {
  return value.split(";").some((part) => {
    const match = /^\s*([^@]+?)\s*@\s*(.+)$/.exec(part);
    if (!match) return false;
    // "no @ bus" oznacza zakaz dla autobusów, więc nie jest wyjątkiem.
    const value = match[1].trim().toLowerCase();
    return (
      value !== "no" &&
      EXEMPT_VALUES.test(value) &&
      BUS_CONDITION.test(match[2].toLowerCase())
    );
  });
}

/**
 * Czy ograniczenie ma dopisek „nie dotyczy komunikacji miejskiej / ZDKiUM”
 * (lub równoważny wyjątek dla autobusów) w tagach OSM, opisie znaku albo na
 * ręcznej liście wyjątków.
 */
export function detectTransitExemption(
  tags: Record<string, string>,
  osmId?: string,
): TransitExemption {
  if (osmId && MANUAL_TRANSIT_EXEMPT_IDS.has(osmId)) {
    return {
      exempt: true,
      source: "manual",
      evidence: "ręcznie oznaczone w konfiguracji aplikacji",
    };
  }

  for (const [key, raw] of Object.entries(tags)) {
    const value = raw.trim();
    if (!value) continue;
    const lowerKey = key.toLowerCase();

    // maxweight:bus=none, maxheight:psv=unlimited …
    if (
      /^max(weight|height|axleload)(:(bus|psv|public_transport))$/.test(lowerKey) &&
      /^(none|no|unlimited|yes)$/.test(value.toLowerCase())
    ) {
      return { exempt: true, source: "osm-tag", evidence: `${key}=${value}` };
    }

    // maxweight:conditional=none @ (bus)
    if (lowerKey.endsWith(":conditional") && LIMIT_KEY.test(lowerKey)) {
      if (conditionalExemptsBus(value)) {
        return { exempt: true, source: "osm-tag", evidence: `${key}=${value}` };
      }
    }

    // except=bus / except=psv
    if (/^(except|exception|maxweight:except|maxheight:except)$/.test(lowerKey)) {
      if (BUS_CONDITION.test(value.toLowerCase())) {
        return { exempt: true, source: "osm-tag", evidence: `${key}=${value}` };
      }
    }

    if (TEXT_KEY.test(lowerKey)) {
      const text = fold(value);
      if (TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
        return { exempt: true, source: "osm-note", evidence: value.slice(0, 160) };
      }
    }
  }
  return NONE;
}

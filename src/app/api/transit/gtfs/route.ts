import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { NextRequest, NextResponse } from "next/server";
import snapshotJson from "@/data/live-duty-snapshot.json";
import { formatDutyCode } from "@/lib/core/text";

const GTFS_FULL_URL = "https://gtfs.walbrzych.eu/GTFS/ST/GTFS%20(full).zip";
const GTFS_SKA_URL = "https://gtfs.walbrzych.eu/GTFS/ST/1%20-%20SKA/GTFS%20(full).zip";
const GTFS_MZUK_URL = "https://gtfs.walbrzych.eu/GTFS/ST/2%20-%20MZUK/GTFS%20(full).zip";

const CACHE_TTL_MS = 6 * 3600_000;

/**
 * `gtfs.walbrzych.eu` serves a certificate for `*.stpl.net.pl`, which standard
 * browser `fetch()` rejects. Scoped strictly to `gtfs.walbrzych.eu` server-side.
 */
const walbrzychTlsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

function downloadBinary(urlStr: string, timeoutMs = 20_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    if (parsed.hostname !== "gtfs.walbrzych.eu") {
      reject(new Error("Nieobsługiwany host GTFS."));
      return;
    }
    const req = https.get(
      parsed,
      {
        agent: walbrzychTlsAgent,
        timeout: timeoutMs,
        headers: {
          Accept: "application/zip, application/octet-stream, */*",
          "User-Agent": "MapPlaner-Walbrzych-GTFS/2.0",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const redirected = new URL(res.headers.location, parsed).toString();
          downloadBinary(redirected, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("Przekroczono czas połączenia z gtfs.walbrzych.eu"));
    });
    req.on("error", reject);
  });
}

function parseTripsDutyKeys(zipBytes: Uint8Array): Array<[string, string]> {
  const files = unzipSync(zipBytes);
  const tripsU8 = files["trips.txt"];
  if (!tripsU8) return [];
  const text = strFromU8(tripsU8).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const splitCsv = (line: string): string[] => {
    if (!line.includes('"')) return line.split(",").map((s) => s.trim());
    const cols: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        cols.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = splitCsv(lines[0]);
  const iService = headers.indexOf("service_id");
  const iBlock = headers.indexOf("block_id");
  if (iService < 0 || iBlock < 0) return [];

  const out: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw) continue;
    const cols = splitCsv(raw);
    const serviceId = cols[iService];
    const blockRaw = cols[iBlock];
    if (!serviceId || !blockRaw) continue;
    out.push([serviceId, formatDutyCode(blockRaw, "/")]);
  }
  return out;
}

let cachedFullZip: { at: number; bytes: Uint8Array; source: string } | null = null;
let cachedOperators: {
  at: number;
  dutyOperators: Record<string, "ska" | "mzuk">;
  source: string;
} | null = null;
let fullInFlight: Promise<{ bytes: Uint8Array; source: string }> | null = null;
let operatorsInFlight: Promise<{
  dutyOperators: Record<string, "ska" | "mzuk">;
  source: string;
}> | null = null;

async function getFullArchiveBytes(force: boolean): Promise<{ bytes: Uint8Array; source: string }> {
  if (!force && cachedFullZip && Date.now() - cachedFullZip.at < CACHE_TTL_MS) {
    return cachedFullZip;
  }
  if (!force && fullInFlight) return fullInFlight;

  const job = (async () => {
    try {
      const bytes = await downloadBinary(GTFS_FULL_URL, force ? 25_000 : 8_000);
      if (bytes.byteLength > 10_000) {
        const entry = {
          at: Date.now(),
          bytes,
          source: "gtfs.walbrzych.eu/GTFS/ST/GTFS (full).zip",
        };
        cachedFullZip = entry;
        return entry;
      }
    } catch {
      /* Fall back to bundled gtfs.walbrzych.eu snapshot */
    }

    if (cachedFullZip) return cachedFullZip;

    const bundledPath = path.join(process.cwd(), "public", "data", "walbrzych-gtfs.zip");
    const buf = await fs.readFile(bundledPath);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const entry = {
      at: Date.now(),
      bytes,
      source: "gtfs.walbrzych.eu (lokalna kopia ST/GTFS full)",
    };
    cachedFullZip = entry;
    return entry;
  })();

  fullInFlight = job.finally(() => {
    fullInFlight = null;
  });
  return fullInFlight;
}

async function getOperatorMap(force: boolean): Promise<{
  dutyOperators: Record<string, "ska" | "mzuk">;
  source: string;
}> {
  if (!force && cachedOperators && Date.now() - cachedOperators.at < CACHE_TTL_MS) {
    return cachedOperators;
  }
  if (!force && operatorsInFlight) return operatorsInFlight;

  const job = (async () => {
    try {
      const [skaBytes, mzukBytes] = await Promise.all([
        downloadBinary(GTFS_SKA_URL, force ? 25_000 : 8_000),
        downloadBinary(GTFS_MZUK_URL, force ? 25_000 : 8_000),
      ]);
      const dutyOperators: Record<string, "ska" | "mzuk"> = {};
      for (const [serviceId, blockCode] of parseTripsDutyKeys(skaBytes)) {
        dutyOperators[`${serviceId}|${blockCode}`] = "ska";
      }
      for (const [serviceId, blockCode] of parseTripsDutyKeys(mzukBytes)) {
        dutyOperators[`${serviceId}|${blockCode}`] = "mzuk";
      }
      if (Object.keys(dutyOperators).length > 0) {
        const entry = {
          at: Date.now(),
          dutyOperators,
          source: "gtfs.walbrzych.eu (1 - SKA & 2 - MZUK)",
        };
        cachedOperators = entry;
        return entry;
      }
    } catch {
      /* Fall back to bundled snapshot operator map */
    }

    const fallback =
      (snapshotJson as unknown as { dutyOperators?: Record<string, "ska" | "mzuk"> })
        .dutyOperators ?? {};
    const entry = {
      at: Date.now(),
      dutyOperators: fallback,
      source: "gtfs.walbrzych.eu (migawka 1 - SKA & 2 - MZUK)",
    };
    cachedOperators = entry;
    return entry;
  })();

  operatorsInFlight = job.finally(() => {
    operatorsInFlight = null;
  });
  return operatorsInFlight;
}

export async function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get("kind") ?? "archive";
  const force = request.nextUrl.searchParams.get("force") === "1";

  if (kind === "operators") {
    try {
      const { dutyOperators, source } = await getOperatorMap(force);
      return NextResponse.json({
        dutyOperators,
        source,
        count: Object.keys(dutyOperators).length,
      });
    } catch (error) {
      console.error("[GET /api/transit/gtfs?kind=operators]", error);
      return NextResponse.json(
        { error: "Nie udało się pobrać podziału brygad na firmy." },
        { status: 500 }
      );
    }
  }

  try {
    const { bytes, source } = await getFullArchiveBytes(force);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "X-Gtfs-Source": encodeURIComponent(source),
        "Cache-Control": force ? "no-store" : "public, max-age=600",
      },
    });
  } catch (error) {
    console.error("[GET /api/transit/gtfs]", error);
    return NextResponse.json(
      { error: "Nie udało się pobrać archiwum GTFS Wałbrzych." },
      { status: 502 }
    );
  }
}

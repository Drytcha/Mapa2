import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UPSTREAM_BASE = "https://api.livetransport.eu/walbrzych";
const ALLOWED_PATH_RE = /^(?:brigades\/[A-Za-z0-9_-]+(?:\?date=\d{8})?|brigade\/[A-Za-z0-9_.:-]+)$/;

interface CacheEntry {
  at: number;
  ttlMs: number;
  body: string;
}

const serverCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path")?.trim() ?? "";
  if (!ALLOWED_PATH_RE.test(path)) {
    return NextResponse.json({ error: "Nieprawidłowa ścieżka zapytania." }, { status: 400 });
  }

  const now = Date.now();
  const hit = serverCache.get(path);
  if (hit && now - hit.at < hit.ttlMs) {
    return new NextResponse(hit.body, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let pending = inFlight.get(path);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(`${UPSTREAM_BASE}/${path}`, {
          headers: {
            Accept: "application/json",
            Origin: "https://livetransport.eu",
            Referer: "https://livetransport.eu/",
          },
          signal: AbortSignal.timeout(7_000),
          cache: "no-store",
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trim().startsWith("[")) return null;
        const ttlMs = path.startsWith("brigade/") ? 6 * 3600_000 : 15 * 60_000;
        serverCache.set(path, { at: Date.now(), ttlMs, body: text });
        if (serverCache.size > 300) {
          const oldest = serverCache.keys().next().value;
          if (oldest) serverCache.delete(oldest);
        }
        return text;
      } catch {
        return null;
      }
    })().finally(() => {
      inFlight.delete(path);
    });
    inFlight.set(path, pending);
  }

  const body = await pending;
  if (!body) {
    return NextResponse.json({ error: "Źródło brygad niedostępne." }, { status: 502 });
  }
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

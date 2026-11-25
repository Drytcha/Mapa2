import { strFromU8, unzipSync } from "fflate";

export interface PackedShapesPayload {
  /** Lista (shapeId, startFloatIndex, pointCount) opisująca tablice w `coords`. */
  entries: Array<[string, number, number]>;
  /** Spłaszczona tablica [lat0, lon0, lat1, lon1, ...] — transferowalna zero-copy. */
  coords: Float64Array;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Rozpakowuje i parsuje wyłącznie `shapes.txt` z paczki GTFS.
 * Zachowuje podział na bloki sekwencji, gdy ten sam `shape_id` pojawia się
 * w kilku niezależnych segmentach (np. oba kierunki w jednym `shape_id`).
 */
export function parseShapesFromZipBytes(
  zipBytes: Uint8Array,
): Map<string, [number, number][]> {
  const files = unzipSync(zipBytes, {
    filter: (file) => file.name === "shapes.txt",
  });
  const entry = files["shapes.txt"];
  const result = new Map<string, [number, number][]>();
  if (!entry) return result;

  const text = strFromU8(entry);
  const clean = text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let pos = 0;
  const len = clean.length;

  const nextLine = (): string | null => {
    while (pos < len) {
      let end = clean.indexOf("\n", pos);
      if (end === -1) end = len;
      const sliceEnd =
        end > pos && clean.charCodeAt(end - 1) === 13 ? end - 1 : end;
      const line = clean.slice(pos, sliceEnd);
      pos = end + 1;
      if (line.length > 0) return line;
    }
    return null;
  };

  const headerLine = nextLine();
  if (!headerLine) return result;
  const header = parseCsvLine(headerLine);
  const indexMap = new Map<string, number>();
  header.forEach((h, idx) => indexMap.set(h, idx));

  const iId = indexMap.get("shape_id") ?? -1;
  const iLat = indexMap.get("shape_pt_lat") ?? -1;
  const iLon = indexMap.get("shape_pt_lon") ?? -1;
  const iSeq = indexMap.get("shape_pt_sequence") ?? -1;
  if (iId < 0 || iLat < 0 || iLon < 0) return result;

  const buckets = new Map<
    string,
    Array<{ block: number; seq: number; lat: number; lon: number }>
  >();
  const lastSeqByShape = new Map<string, number>();
  const blockByShape = new Map<string, number>();

  let line = nextLine();
  while (line !== null) {
    const cols = parseCsvLine(line);
    const shapeId = cols[iId] ?? "";
    if (shapeId) {
      const lat = Number.parseFloat(cols[iLat] ?? "");
      const lon = Number.parseFloat(cols[iLon] ?? "");
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const seq = iSeq >= 0 ? Number.parseInt(cols[iSeq] ?? "", 10) || 0 : 0;
        const previous = lastSeqByShape.get(shapeId);
        let block = blockByShape.get(shapeId) ?? 0;
        if (previous !== undefined && seq <= previous) {
          block += 1;
          blockByShape.set(shapeId, block);
        }
        lastSeqByShape.set(shapeId, seq);
        const point = { block, seq, lat, lon };
        const list = buckets.get(shapeId);
        if (list) list.push(point);
        else buckets.set(shapeId, [point]);
      }
    }
    line = nextLine();
  }

  for (const [shapeId, points] of buckets) {
    points.sort((a, b) => a.block - b.block || a.seq - b.seq);
    result.set(
      shapeId,
      points.map((point) => [point.lat, point.lon] as [number, number]),
    );
  }
  return result;
}

export function packShapesForTransfer(
  shapes: Map<string, [number, number][]>,
): PackedShapesPayload {
  let totalPoints = 0;
  for (const pts of shapes.values()) totalPoints += pts.length;

  const coords = new Float64Array(totalPoints * 2);
  const entries: Array<[string, number, number]> = [];
  let cursor = 0;

  for (const [shapeId, pts] of shapes) {
    entries.push([shapeId, cursor, pts.length]);
    for (let i = 0; i < pts.length; i += 1) {
      coords[cursor] = pts[i][0];
      coords[cursor + 1] = pts[i][1];
      cursor += 2;
    }
  }

  return { entries, coords };
}

export function unpackShapesFromTransfer(
  payload: PackedShapesPayload,
): Map<string, [number, number][]> {
  const result = new Map<string, [number, number][]>();
  const { entries, coords } = payload;
  for (let i = 0; i < entries.length; i += 1) {
    const [shapeId, start, count] = entries[i];
    const pts = new Array<[number, number]>(count);
    let idx = start;
    for (let j = 0; j < count; j += 1) {
      pts[j] = [coords[idx], coords[idx + 1]];
      idx += 2;
    }
    result.set(shapeId, pts);
  }
  return result;
}

import turfArea from '@turf/area';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { isStrictlyInside, ringBBox } from '../components/map/geo';

// Hellenic Cadastre (Ελληνικό Κτηματολόγιο) parcels, read from the same public ArcGIS Online
// feature layers that maps.ktimatologio.gr uses. HTTPS, no key, CORS open to all origins.
// Terms of use: reproduction allowed with the credit below, without altering the data.
const BASE = 'https://services-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services';

export type ParcelStage = 'operating' | 'posted';

// Checked in this order: the operating cadastre first, then areas still under posting
// (ανάρτηση, published for objections but not yet final).
const LAYERS: { stage: ParcelStage; url: string }[] = [
  { stage: 'operating', url: `${BASE}/GEOTEMAXIA_LEITOURGOUN_ON_gdb/FeatureServer/0/query` },
  { stage: 'posted', url: `${BASE}/GEOTEMAXIA_ANARTHSH_ON_gdb/FeatureServer/0/query` },
];

export const CADASTRE_ATTRIBUTION = 'Πηγή δεδομένων: Ν.Π.Δ.Δ. ΕΛΛΗΝΙΚΟ ΚΤΗΜΑΤΟΛΟΓΙΟ';

const PAGE_SIZE = 2000; // the layers' maxRecordCount
const MAX_PAGES = 3; // safety cap per square and layer
const CELL_DEG = 0.02; // parcels are loaded in squares of about 2 km, then cached
const OUTLINE_OFFSET_DEG = 0.00001; // outlines simplified to about 1 m (picking uses full detail)
const CACHE_CELLS = 80;
export const MAX_CELLS_PER_VIEW = 36; // a view needing more is zoomed out too far

export interface ParcelProps {
  pid: string; // unique across layers, e.g. "operating-123"
  stage: ParcelStage;
}

export interface ParcelHit {
  kaek: string | null;
  stage: ParcelStage;
  // The parcel's outer boundary (the part under the click, for multi-part parcels)
  polygon: Polygon;
  // Area and perimeter as published by the Cadastre (computed from the shape if missing)
  areaHa: number;
  perimeterM: number;
  // The parcel encloses other parcels, so its outer boundary would claim them too
  hasHoles: boolean;
}

export type ParcelFeature = Feature<Polygon | MultiPolygon, ParcelProps>;

type Bounds = { west: number; south: number; east: number; north: number };

function params(entries: Record<string, string | number | boolean>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) p.set(k, String(v));
  return p.toString();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Cadastre request failed (${res.status})`);
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(data.error.message ?? 'Cadastre error');
  }
  return data;
}

async function fetchCell(col: number, row: number, signal: AbortSignal): Promise<ParcelFeature[]> {
  const west = col * CELL_DEG;
  const south = row * CELL_DEG;
  const out: ParcelFeature[] = [];

  await Promise.all(
    LAYERS.map(async (layer) => {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${layer.url}?${params({
          f: 'geojson',
          where: '1=1',
          geometry: `${west},${south},${west + CELL_DEG},${south + CELL_DEG}`,
          geometryType: 'esriGeometryEnvelope',
          inSR: 4326,
          spatialRel: 'esriSpatialRelIntersects',
          outFields: 'OBJECTID',
          returnGeometry: true,
          outSR: 4326,
          geometryPrecision: 6,
          maxAllowableOffset: OUTLINE_OFFSET_DEG,
          orderByFields: 'OBJECTID ASC',
          resultOffset: page * PAGE_SIZE,
          resultRecordCount: PAGE_SIZE,
        })}`;
        const data = await getJson<FeatureCollection<Polygon | MultiPolygon, { OBJECTID?: number }>>(url, signal);
        const features = data.features ?? [];
        for (const f of features) {
          if (!f.geometry) continue;
          const id = f.properties?.OBJECTID ?? f.id;
          out.push({
            type: 'Feature',
            properties: { pid: `${layer.stage}-${id}`, stage: layer.stage },
            geometry: f.geometry,
          });
        }
        if (features.length < PAGE_SIZE) break; // last page
      }
    }),
  );
  return out;
}

// Loads and caches parcel outlines by map square, so panning only fetches new areas
export class ParcelOutlineCache {
  private cells = new Map<string, Promise<ParcelFeature[]>>();

  // Number of squares a view would need (used to refuse views that are too large)
  static cellCount(b: Bounds): number {
    const cols = Math.floor(b.east / CELL_DEG) - Math.floor(b.west / CELL_DEG) + 1;
    const rows = Math.floor(b.north / CELL_DEG) - Math.floor(b.south / CELL_DEG) + 1;
    return cols * rows;
  }

  async getView(b: Bounds, signal: AbortSignal): Promise<FeatureCollection<Polygon | MultiPolygon, ParcelProps>> {
    const jobs: Promise<ParcelFeature[]>[] = [];
    for (let col = Math.floor(b.west / CELL_DEG); col <= Math.floor(b.east / CELL_DEG); col++) {
      for (let row = Math.floor(b.south / CELL_DEG); row <= Math.floor(b.north / CELL_DEG); row++) {
        const key = `${col}:${row}`;
        let job = this.cells.get(key);
        if (job) {
          // Refresh its position so recently used squares stay cached
          this.cells.delete(key);
        } else {
          // Squares are shared between views, so they are not aborted with one view
          const controller = new AbortController();
          job = fetchCell(col, row, controller.signal);
          job.catch(() => this.cells.delete(key)); // retry a failed square next time
        }
        this.cells.set(key, job);
        jobs.push(job);
      }
    }
    while (this.cells.size > CACHE_CELLS) {
      const oldest = this.cells.keys().next().value;
      if (oldest === undefined) break;
      this.cells.delete(oldest);
    }

    const parts = await Promise.all(jobs);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // A parcel crossing a square border comes back from both squares
    const seen = new Set<string>();
    const features: ParcelFeature[] = [];
    for (const part of parts) {
      for (const f of part) {
        if (seen.has(f.properties.pid)) continue;
        seen.add(f.properties.pid);
        features.push(f);
      }
    }
    return { type: 'FeatureCollection', features };
  }
}

// Length of a lon/lat ring in metres (great-circle distance between corners)
function ringPerimeterM(ring: Position[]): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 1; i < ring.length; i++) {
    const [lon1, lat1] = ring[i - 1];
    const [lon2, lat2] = ring[i];
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return total;
}

type CadastreAttrs = { KAEK?: string | null; AREA?: number | null; PERIMETER?: number | null };
type CadastreFeature = Feature<Polygon | MultiPolygon, CadastreAttrs>;

// Turns a Cadastre feature into a ParcelHit, keeping one part of a multi-part parcel
function toHit(
  feature: CadastreFeature,
  stage: ParcelStage,
  choosePart: (parts: Position[][][]) => Position[][] | undefined,
): ParcelHit | null {
  const parts: Position[][][] =
    feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const part = choosePart(parts) ?? parts[0];
  if (!part?.[0]) return null;

  const polygon: Polygon = { type: 'Polygon', coordinates: [part[0]] };
  const wholeParcel = parts.length === 1;
  const props = feature.properties ?? {};
  return {
    kaek: props.KAEK?.trim() || null,
    stage,
    polygon,
    // The Cadastre's AREA (m squared) and PERIMETER (m) describe the whole parcel, so they are used
    // only when the parcel is a single part; otherwise the chosen part is measured here
    areaHa: (wholeParcel && props.AREA ? props.AREA : turfArea(polygon)) / 10000,
    perimeterM: wholeParcel && props.PERIMETER ? props.PERIMETER : ringPerimeterM(part[0]),
    hasHoles: part.length > 1,
  };
}

const FULL_DETAIL = {
  f: 'geojson',
  outFields: 'KAEK,AREA,PERIMETER',
  returnGeometry: true,
  outSR: 4326,
  geometryPrecision: 7,
  resultRecordCount: 1,
} as const;

// The parcel at a point, with its full-detail boundary, or null when there is none
export async function fetchParcelAt(lng: number, lat: number, signal?: AbortSignal): Promise<ParcelHit | null> {
  const point: Position = [lng, lat];
  for (const layer of LAYERS) {
    const url = `${layer.url}?${params({
      ...FULL_DETAIL,
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects',
    })}`;
    const data = await getJson<FeatureCollection<Polygon | MultiPolygon, CadastreAttrs>>(url, signal);
    const feature = data.features?.find((f) => f.geometry);
    if (!feature) continue;
    // Multi-part parcel: keep the part that was clicked
    const hit = toHit(feature, layer.stage, (parts) =>
      parts.find((rings) => rings[0] && isStrictlyInside(point, { ring: rings[0], bbox: ringBBox(rings[0]) })),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Normalises what a farmer typed as a ΚΑΕΚ: drops spaces and dashes, keeps digits, Latin letters
 * and "/". Returns null when it cannot be a ΚΑΕΚ (ΚΑΕΚ codes are 12 digits, some with a suffix).
 */
export function normaliseKaek(input: string): string | null {
  const value = input.replace(/[\s\-.]/g, '').toUpperCase();
  return /^[0-9][0-9A-Z/]{8,19}$/.test(value) ? value : null;
}

// The parcel with a given ΚΑΕΚ, or null when no layer has it
export async function fetchParcelByKaek(kaek: string, signal?: AbortSignal): Promise<ParcelHit | null> {
  const value = normaliseKaek(kaek);
  if (!value) return null;
  for (const layer of LAYERS) {
    const url = `${layer.url}?${params({
      ...FULL_DETAIL,
      // value is limited to [0-9A-Z/], so it cannot break out of the quotes
      where: `KAEK='${value}'`,
    })}`;
    const data = await getJson<FeatureCollection<Polygon | MultiPolygon, CadastreAttrs>>(url, signal);
    const feature = data.features?.find((f) => f.geometry);
    if (!feature) continue;
    // Multi-part parcel: keep its largest part
    const hit = toHit(feature, layer.stage, (parts) =>
      parts.reduce<Position[][] | undefined>((best, rings) => {
        if (!rings[0]) return best;
        if (!best) return rings;
        const area = (r: Position[][]) => turfArea({ type: 'Polygon', coordinates: [r[0]] });
        return area(rings) > area(best) ? rings : best;
      }, undefined),
    );
    if (hit) return hit;
  }
  return null;
}
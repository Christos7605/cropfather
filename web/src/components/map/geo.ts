import type { Polygon, Position } from 'geojson';

// Small geometry helpers for drawing on the map
// Coordinates
export type BBox = [number, number, number, number];

export interface IndexedRing {
  ring: Position[];
  bbox: BBox;
}

export function ringBBox(ring: Position[]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

export function indexPolygons(polygons: Polygon[]): IndexedRing[] {
  return polygons
    .map((p) => p.coordinates[0])
    .filter((ring): ring is Position[] => Array.isArray(ring) && ring.length >= 4)
    .map((ring) => ({ ring, bbox: ringBBox(ring) }));
}

export function polygonBBox(polygon: Polygon): BBox {
  return ringBBox(polygon.coordinates[0] ?? []);
}

// Distance in degrees below which a point counts as "on the edge"
// Corners snapped onto a neighbour's edge must not count as inside it
const EDGE_EPSILON = 2e-7;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// True when the point lies clearly inside the ring (points on or very near the edge are outside)
export function isStrictlyInside(point: Position, item: IndexedRing): boolean {
  const [x, y] = point;
  const [w, s, e, n] = item.bbox;
  if (x <= w || x >= e || y <= s || y >= n) return false;

  const ring = item.ring;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (distanceToSegment(x, y, xi, yi, xj, yj) < EDGE_EPSILON) return false;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isInsideAny(point: Position, rings: IndexedRing[]): boolean {
  for (const r of rings) if (isStrictlyInside(point, r)) return true;
  return false;
}

type Project = (lng: number, lat: number) => { x: number; y: number };
type Unproject = (x: number, y: number) => { lng: number; lat: number };


// Function that finds the closest corner (within vertexPx pixels) or edge point (within edgePx pixels)
// of the given rings. Corners win over edges so shared corners line up exactly
export function findSnapPoint(
  lng: number,
  lat: number,
  rings: IndexedRing[],
  project: Project,
  unproject: Unproject,
  vertexPx = 12,
  edgePx = 9,
): Position | undefined {
  if (rings.length === 0) return undefined;

  const p = project(lng, lat);
  const corner = unproject(p.x + vertexPx, p.y + vertexPx);
  const tolLng = Math.abs(corner.lng - lng);
  const tolLat = Math.abs(corner.lat - lat);

  let bestVertex: Position | undefined;
  let bestVertexDist = vertexPx;
  let bestEdge: { x: number; y: number } | undefined;
  let bestEdgeDist = edgePx;

  for (const { ring, bbox } of rings) {
    if (lng < bbox[0] - tolLng || lng > bbox[2] + tolLng || lat < bbox[1] - tolLat || lat > bbox[3] + tolLat) {
      continue;
    }
    let prev = project(ring[0][0], ring[0][1]);
    for (let i = 0; i < ring.length; i++) {
      const cur = i === 0 ? prev : project(ring[i][0], ring[i][1]);
      const dv = Math.hypot(cur.x - p.x, cur.y - p.y);
      if (dv < bestVertexDist) {
        bestVertexDist = dv;
        bestVertex = ring[i];
      }
      if (i > 0) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        const len2 = dx * dx + dy * dy;
        if (len2 > 0) {
          const t = Math.max(0, Math.min(1, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / len2));
          const cx = prev.x + t * dx;
          const cy = prev.y + t * dy;
          const de = Math.hypot(p.x - cx, p.y - cy);
          if (de < bestEdgeDist) {
            bestEdgeDist = de;
            bestEdge = { x: cx, y: cy };
          }
        }
      }
      prev = cur;
    }
  }

  if (bestVertex) return [bestVertex[0], bestVertex[1]];
  if (bestEdge) {
    const ll = unproject(bestEdge.x, bestEdge.y);
    return [ll.lng, ll.lat];
  }
  return undefined;
}

// Diagonal hatch pattern (RGBA) used to show land that cannot be marked
export function createHatchPattern(size = 12, rgb: [number, number, number] = [192, 204, 197]) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const onLine = (x + y) % size < 2;
      const i = (y * size + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = onLine ? 170 : 28;
    }
  }
  return { width: size, height: size, data };
}
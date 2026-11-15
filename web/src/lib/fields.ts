import type { Polygon } from 'geojson';
import { supabase } from './supabase';
import { en, type MessageKey } from '../i18n/en';

// ---------------------------------------------------------------------------
// Types (mirror the my_fields view and the RPCs in 0004_map_module.sql)
// ---------------------------------------------------------------------------
export type Irrigation = 'rainfed' | 'limited' | 'full';
export type BoundarySource = 'drawn' | 'cadastre' | 'cadastre_edited';
export const IRRIGATION_OPTIONS: Irrigation[] = ['rainfed', 'limited', 'full'];

export interface FieldRecord {
  id: string;
  name: string;
  irrigation: Irrigation;
  area_ha: number | null;
  perimeter_m: number | null;
  cell_id: number | null;
  elevation_m: number | null;
  slope_deg: number | null;
  created_at: string;
  updated_at: string;
  geom_updated_at: string;
  centroid_lon: number | null;
  centroid_lat: number | null;
  geometry: Polygon;
  history_count: number;
  boundary_source: BoundarySource;
  /** Cadastre parcel code (ΚΑΕΚ) the boundary started from, if any */
  kaek: string | null;
  /** Water point (ΕΜΣΥ register) that waters the field, chosen by the farmer */
  water_point_id: number | null;
  /** Borehole depth in metres, as drilled, as stated by the farmer */
  well_depth_m: number | null;
  /** How deep the pump hangs in the borehole, metres (optional; used for the irrigation energy) */
  pump_depth_m?: number | null;
  well_code: string | null;
  well_status: string | null;
  well_kind: string | null;
  well_lon: number | null;
  well_lat: number | null;
  /** Latest questionnaire response for this field (null when not started) */
  survey_version: string | null;
  survey_status: 'draft' | 'submitted' | null;
  survey_answered: number | null;
  survey_total: number | null;
  survey_updated_at: string | null;
}

export interface FieldPreview {
  status: 'ok' | 'trimmed' | 'invalid';
  code: string | null;
  area_ha?: number;
  perimeter_m?: number;
  overlap_m2?: number;
  overlap_own_m2?: number;
  overlap_other_m2?: number;
  parts?: number;
  geometry?: Polygon | null;
}

/** An error that carries the code the database (or Supabase) sent back. */
export class FieldError extends Error {
  code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.code = code;
  }
}

const toFieldError = (err: { code?: string | null; message: string }) =>
  new FieldError(err.code ?? null, err.message);

/** Guest accounts may save 3 fields, registered accounts 25 (enforced in the database). */
export const fieldLimit = (isAnonymous: boolean) => (isAnonymous ? 3 : 25);

/** Rounds to 7 decimals (about 1 cm), the precision stored and returned by the database. */
export const roundPolygon = (polygon: Polygon): Polygon => ({
  type: 'Polygon',
  coordinates: polygon.coordinates.map((ring) =>
    ring.map(([lon, lat]) => [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]),
  ),
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export async function listMyFields(): Promise<FieldRecord[]> {
  const { data, error } = await supabase
    .from('my_fields')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw toFieldError(error);
  return (data ?? []) as FieldRecord[];
}

export async function previewField(geometry: Polygon, excludeId: string | null): Promise<FieldPreview> {
  const { data, error } = await supabase.rpc('field_preview', {
    p_geometry: roundPolygon(geometry),
    p_exclude_id: excludeId,
  });
  if (error) throw toFieldError(error);
  return data as FieldPreview;
}

export async function createField(
  name: string,
  geometry: Polygon,
  irrigation: Irrigation,
  source: BoundarySource = 'drawn',
  kaek: string | null = null,
): Promise<FieldRecord> {
  const { data, error } = await supabase.rpc('create_field', {
    p_name: name,
    p_geometry: roundPolygon(geometry),
    p_irrigation: irrigation,
    p_source: source,
    p_kaek: source === 'drawn' ? null : kaek,
  });
  if (error) throw toFieldError(error);
  const row = (Array.isArray(data) ? data[0] : data) as FieldRecord | undefined;
  if (!row) throw new FieldError(null, 'No field returned');
  return row;
}

export async function updateFieldGeometry(id: string, geometry: Polygon): Promise<FieldRecord> {
  const { data, error } = await supabase.rpc('update_field_geometry', {
    p_id: id,
    p_geometry: roundPolygon(geometry),
  });
  if (error) throw toFieldError(error);
  const row = (Array.isArray(data) ? data[0] : data) as FieldRecord | undefined;
  if (!row) throw new FieldError(null, 'No field returned');
  return row;
}

export async function updateFieldDetails(
  id: string,
  patch: Partial<Pick<FieldRecord, 'name' | 'irrigation'>>,
): Promise<void> {
  const { error } = await supabase.from('fields').update(patch).eq('id', id);
  if (error) throw toFieldError(error);
}

export async function deleteField(id: string): Promise<void> {
  const { error } = await supabase.from('fields').delete().eq('id', id);
  if (error) throw toFieldError(error);
}

/** Outlines of land registered by other farmers in the given box (shapes only). */
export async function fetchNeighbourFields(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<Polygon[]> {
  const { data, error } = await supabase.rpc('neighbour_fields', {
    p_west: west,
    p_south: south,
    p_east: east,
    p_north: north,
  });
  if (error) throw toFieldError(error);
  return ((data ?? []) as { geometry: Polygon }[]).map((r) => r.geometry);
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------
/** Translated message for a database/Supabase error code, or null when the code is unknown. */
export function errorKeyFor(code: string | null | undefined): MessageKey | null {
  if (!code) return null;
  return code in en.errors ? (`errors.${code}` as MessageKey) : null;
}

export function describeError(err: unknown, t: (key: MessageKey) => string): string {
  if (err instanceof FieldError) {
    const key = errorKeyFor(err.code);
    return key ? t(key) : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
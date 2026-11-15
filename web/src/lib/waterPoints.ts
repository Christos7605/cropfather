import { supabase } from './supabase';
import { FieldError, type FieldRecord } from './fields';

// Water points of the National Register of Water Abstraction Points (ΕΜΣΥ), open data from
// data.gov.gr, loaded into the database (public.water_points, see 0006_water_points.sql)

export type WaterPointStatus = 'active' | 'inactive' | 'unknown';
export type WaterPointKind =
  | 'borehole'
  | 'well'
  | 'spring'
  | 'river'
  | 'stream'
  | 'lake'
  | 'coastal'
  | 'transitional'
  | 'other'
  | 'unknown';
export type WaterPointOwnership = 'private' | 'municipal' | 'public' | 'other' | 'unknown';

export interface WaterPoint {
  id: number;
  code: string;
  status: WaterPointStatus;
  kind: WaterPointKind;
  lon: number;
  lat: number;
  // Present when the point came from the map layer; missing for a field's saved link
  ownership?: WaterPointOwnership;
  municipality?: string | null;
  community?: string | null;
  river_basin?: string | null;
}

export const WATER_POINTS_ATTRIBUTION = 'Σημεία υδροληψίας: ΕΜΣΥ, data.gov.gr';

// Kinds where a depth makes sense (a borehole or a dug well); not for springs, rivers, lakes
export const DEPTH_KINDS: WaterPointKind[] = ['borehole', 'well', 'other', 'unknown'];
export const MAX_DEPTH_M = 2000;
// Beyond this distance from the field, the farmer is asked to double-check the choice
export const FAR_WELL_KM = 3;

// Water points inside a box (at most around 0.8 degrees per side and 6,000 points, enforced by the database)
export async function fetchWaterPointsInView(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<WaterPoint[]> {
  const { data, error } = await supabase.rpc('water_points_in_view', {
    p_west: west,
    p_south: south,
    p_east: east,
    p_north: north,
  });
  if (error) throw new FieldError(error.code ?? null, error.message);
  return (data ?? []) as WaterPoint[];
}

// Links a water point (and its depth) to a field, or clears the link with nulls and returns the updated field
export async function setFieldWaterSource(
  fieldId: string,
  waterPointId: number | null,
  depthM: number | null,
): Promise<FieldRecord> {
  const { error } = await supabase
    .from('fields')
    .update({ water_point_id: waterPointId, well_depth_m: waterPointId === null ? null : depthM })
    .eq('id', fieldId);
  if (error) throw new FieldError(error.code ?? null, error.message);

  const { data, error: readError } = await supabase.from('my_fields').select('*').eq('id', fieldId).single();
  if (readError) throw new FieldError(readError.code ?? null, readError.message);
  return data as FieldRecord;
}

// The point a field is linked to, rebuilt from the my_fields columns (null when there is none)
export function linkedWaterPoint(field: FieldRecord): WaterPoint | null {
  if (field.water_point_id == null || field.well_lon == null || field.well_lat == null) return null;
  return {
    id: field.water_point_id,
    code: field.well_code ?? '',
    status: (field.well_status ?? 'unknown') as WaterPointStatus,
    kind: (field.well_kind ?? 'unknown') as WaterPointKind,
    lon: field.well_lon,
    lat: field.well_lat,
  };
}

// Great-circle distance in kilometres
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

// Parses what the farmer typed as a depth. Accepts "120", "120.5" and "120,5"
// Returns null for an empty box, NaN when the value is not a valid depth
export function parseDepth(input: string): number | null {
  const text = input.trim().replace(',', '.');
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_DEPTH_M) return Number.NaN;
  return Math.round(value * 10) / 10;
}
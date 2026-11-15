import { supabase } from './supabase';
import { FieldError } from './fields';
import type { Irrigation } from './fields';
import { roundCents, type Season, type SeasonIrrigation as IrrigationLevelAnswer } from './seasons';

// Irrigation of a season (table season_irrigation) and its cost. The calculation below is the same
// as the database view season_irrigation_costs (migration 20261106), line for line, so the app and
// the database always show the same figures. Everything is per hectare; the app shows per stremma
// (per ha / 10). 1 mm of water = 10 m³/ha = 1 m³/stremma

export type WaterSource = 'borehole' | 'surface' | 'network' | 'none';
export const WATER_SOURCES: WaterSource[] = ['borehole', 'surface', 'network', 'none'];
export type PumpPower = 'electric' | 'diesel';
export const PUMP_POWERS: PumpPower[] = ['electric', 'diesel'];
export type IrrigationMethod = 'drip' | 'sprinkler' | 'reel' | 'surface';
export const IRRIGATION_METHODS: IrrigationMethod[] = ['drip', 'sprinkler', 'reel', 'surface'];

// One row of season_irrigation (bill, kWh, litres and water are totals for this field's season)
export interface SeasonIrrigationRecord {
  season_id: number;
  source: WaterSource;
  power: PumpPower | null;
  method: IrrigationMethod | null;
  water_m3: number | null;
  pump_hours: number | null;
  pump_flow_m3h: number | null;
  electric_bill_eur: number | null;
  electric_kwh: number | null;
  meter_share_pct: number | null;
  diesel_l: number | null;
  diesel_price_eur_l: number | null;
  network_fee_eur_ha: number | null;
  consumables_eur_ha: number | null;
}

export type IrrigationInput = Omit<SeasonIrrigationRecord, 'season_id'>;

export interface IrrigationParams {
  electricity_eur_kwh: number;
  diesel_eur_l: number;
  pump_efficiency_electric: number;
  pump_efficiency_diesel: number;
  diesel_kwh_per_l: number;
  head_drip_m: number;
  head_sprinkler_m: number;
  head_reel_m: number;
  head_surface_m: number;
  surface_lift_m: number;
  level_some: number;
  level_full: number;
}

// Used only if the parameter table cannot be read; same starting values as the migration
export const DEFAULT_IRRIGATION_PARAMS: IrrigationParams = {
  electricity_eur_kwh: 0.11,
  diesel_eur_l: 1.2,
  pump_efficiency_electric: 0.5,
  pump_efficiency_diesel: 0.65,
  diesel_kwh_per_l: 3,
  head_drip_m: 20,
  head_sprinkler_m: 35,
  head_reel_m: 70,
  head_surface_m: 5,
  surface_lift_m: 5,
  level_some: 0.5,
  level_full: 1,
};

export interface IrrigationBaseline {
  crop_id: string;
  // Water of a fully irrigated season, mm (= m³ per stremma)
  full_mm: number;
  typical_method: IrrigationMethod;
}

// What the calculation needs to know about the field
export interface IrrigationField {
  area_ha: number | null;
  water_point_id: number | null;
  irrigation: Irrigation;
  well_depth_m: number | null;
  pump_depth_m: number | null;
}

// Limits as the app asks them (per stremma where it applies); the database checks the same
export const IRRIGATION_LIMITS = {
  waterM3: 10_000_000,
  hours: 5000,
  flow: 2000,
  bill: 1_000_000,
  kwh: 10_000_000,
  dieselL: 1_000_000,
  dieselPrice: 5,
  feeStremma: 500,
  consumablesStremma: 500,
} as const;

const fail = (error: { code?: string | null; message: string }) => new FieldError(error.code ?? null, error.message);

const IRRIGATION_COLUMNS =
  'season_id, source, power, method, water_m3, pump_hours, pump_flow_m3h, electric_bill_eur, electric_kwh, meter_share_pct, diesel_l, diesel_price_eur_l, network_fee_eur_ha, consumables_eur_ha';

export async function listIrrigation(seasonIds: number[]): Promise<SeasonIrrigationRecord[]> {
  if (seasonIds.length === 0) return [];
  const { data, error } = await supabase.from('season_irrigation').select(IRRIGATION_COLUMNS).in('season_id', seasonIds);
  if (error) throw fail(error);
  return (data ?? []) as SeasonIrrigationRecord[];
}

export async function listIrrigationParams(): Promise<IrrigationParams> {
  const { data, error } = await supabase.from('irrigation_parameters').select('key, value');
  if (error) throw fail(error);
  const params = { ...DEFAULT_IRRIGATION_PARAMS };
  for (const row of (data ?? []) as { key: keyof IrrigationParams; value: number }[]) {
    if (row.key in params) params[row.key] = Number(row.value);
  }
  return params;
}

export async function listIrrigationBaselines(): Promise<Map<string, IrrigationBaseline>> {
  const { data, error } = await supabase.from('crop_irrigation_baselines').select('crop_id, full_mm, typical_method');
  if (error) throw fail(error);
  return new Map(((data ?? []) as IrrigationBaseline[]).map((b) => [b.crop_id, { ...b, full_mm: Number(b.full_mm) }]));
}

// Saves the pump depth of the field's borehole (null clears it)
export async function setPumpDepth(fieldId: string, depthM: number | null): Promise<void> {
  const { error } = await supabase.from('fields').update({ pump_depth_m: depthM }).eq('id', fieldId);
  if (error) throw fail(error);
}

export type WaterBasis = 'reported' | 'estimated';
export type LiftBasis = 'pump_depth' | 'borehole_depth' | 'default';
export type EnergyBasis = 'reported' | 'estimated' | 'unknown';
export type IrrigationBasis =
  | 'not_irrigated'
  | 'ongoing'
  | 'unknown_source'
  | 'no_reference'
  | 'estimated'
  | 'estimated_from_volume'
  | 'reported';

export interface IrrigationResult {
  source: WaterSource | null;
  power: PumpPower | null;
  method: IrrigationMethod | null;
  level: number;
  // m³ per ha (unrounded)
  waterHa: number | null;
  waterBasis: WaterBasis | null;
  liftM: number | null;
  liftBasis: LiftBasis | null;
  pressureM: number | null;
  headM: number | null;
  // Pumping energy per ha: kWh (electric) or litres (diesel), unrounded
  kwhHa: number | null;
  litresHa: number | null;
  // Price per kWh or per litre used
  unitPrice: number | null;
  energyLine: boolean;
  energyBasis: EnergyBasis | null;
  // € per ha, rounded to cents like the cost lines; null when not known
  energyEurHa: number | null;
  networkLine: boolean;
  networkEurHa: number | null;
  consumablesLine: boolean;
  consumablesEurHa: number | null;
  basis: IrrigationBasis;
  // Sum of the priced parts, € per ha (null when nothing is priced)
  totalEurHa: number | null;
  // Parts needed but not priced
  unpriced: number;
  estimated: boolean;
}

const round2 = roundCents;
const GRAVITY_KWH = 9.81 / 3600; // kWh to lift 1 m³ of water by 1 m

// The season's irrigation level: the season's own answer, else the field's water supply
export function irrigationLevel(
  answer: IrrigationLevelAnswer | null | undefined,
  fieldIrrigation: Irrigation,
  params: IrrigationParams,
): number {
  const level =
    answer && answer !== 'unknown'
      ? answer
      : fieldIrrigation === 'rainfed'
        ? 'none'
        : fieldIrrigation === 'limited'
          ? 'some'
          : 'full';
  return level === 'none' ? 0 : level === 'some' ? params.level_some : params.level_full;
}

/**
 * The irrigation of a season and its cost, per hectare. record null: nothing recorded, so the
 * source is a borehole when the field has a water point and is not rainfed, with an electric pump
 * and the crop's usual method. Same rules as the view season_irrigation_costs
 */
export function irrigationCost(
  season: Pick<Season, 'sown_on' | 'harvested_on' | 'irrigation' | 'crop_id'>,
  record: IrrigationInput | null,
  field: IrrigationField,
  params: IrrigationParams,
  baselines: Map<string, IrrigationBaseline>,
): IrrigationResult {
  const ongoing = Boolean(season.sown_on && !season.harvested_on);
  const baseline = baselines.get(season.crop_id);
  const area = field.area_ha;
  const source: WaterSource | null =
    record?.source ?? (field.water_point_id != null && field.irrigation !== 'rainfed' ? 'borehole' : null);
  const power: PumpPower | null = source === 'borehole' || source === 'surface' ? record?.power ?? 'electric' : null;
  const method: IrrigationMethod | null = record?.method ?? baseline?.typical_method ?? null;
  const share = (record?.meter_share_pct ?? 100) / 100;
  const level = irrigationLevel(season.irrigation, field.irrigation, params);

  // Water
  const reportedM3 =
    record?.water_m3 ?? (record?.pump_hours != null && record.pump_flow_m3h != null ? record.pump_hours * record.pump_flow_m3h : null);
  const waterRep = area != null && area > 0 && reportedM3 != null ? reportedM3 / area : null;
  const waterEst = !ongoing && baseline ? baseline.full_mm * level * 10 : null;
  const waterHa = source === 'none' ? 0 : waterRep ?? waterEst;
  const waterBasis: WaterBasis | null =
    source === 'none' ? null : waterRep != null ? 'reported' : waterEst != null ? 'estimated' : null;

  // Lift and head
  const liftM =
    source === 'borehole'
      ? field.pump_depth_m ?? field.well_depth_m
      : source === 'surface'
        ? params.surface_lift_m
        : source === 'network'
          ? 0
          : null;
  const liftBasis: LiftBasis | null =
    source === 'borehole'
      ? field.pump_depth_m != null
        ? 'pump_depth'
        : field.well_depth_m != null
          ? 'borehole_depth'
          : null
      : source === 'surface'
        ? 'default'
        : null;
  const pressureM =
    method === 'drip'
      ? params.head_drip_m
      : method === 'sprinkler'
        ? params.head_sprinkler_m
        : method === 'reel'
          ? params.head_reel_m
          : method === 'surface'
            ? params.head_surface_m
            : null;
  const headM = (source === 'borehole' || source === 'surface') && liftM != null && pressureM != null ? liftM + pressureM : null;

  // Energy
  const elRepEurHa =
    power === 'electric' && area != null && area > 0
      ? record?.electric_bill_eur != null
        ? (record.electric_bill_eur * share) / area
        : record?.electric_kwh != null
          ? (record.electric_kwh * share * params.electricity_eur_kwh) / area
          : null
      : null;
  const elRepKwhHa =
    power === 'electric' && area != null && area > 0 && record?.electric_kwh != null ? (record.electric_kwh * share) / area : null;
  const dieselRepLHa = power === 'diesel' && area != null && area > 0 && record?.diesel_l != null ? record.diesel_l / area : null;
  const dieselPrice = record?.diesel_price_eur_l ?? params.diesel_eur_l;
  const hydKwhHa = headM != null && waterHa != null ? GRAVITY_KWH * headM * waterHa : null;
  const energyReported = elRepEurHa != null || dieselRepLHa != null;

  const kwhHa =
    power === 'electric'
      ? elRepKwhHa ?? (elRepEurHa == null && hydKwhHa != null ? hydKwhHa / params.pump_efficiency_electric : null)
      : null;
  const litresHa =
    power === 'diesel'
      ? dieselRepLHa ?? (hydKwhHa != null ? hydKwhHa / (params.pump_efficiency_diesel * params.diesel_kwh_per_l) : null)
      : null;
  const water = waterHa ?? 0;
  const energyLine = (power !== null && (energyReported || water > 0)) || (source === null && water > 0);
  const energyCost =
    power === 'electric'
      ? elRepEurHa ?? (kwhHa != null ? kwhHa * params.electricity_eur_kwh : null)
      : power === 'diesel'
        ? litresHa != null
          ? litresHa * dieselPrice
          : null
        : null;
  const energyBasis: EnergyBasis | null = !energyLine
    ? null
    : energyCost == null
      ? 'unknown'
      : energyReported
        ? 'reported'
        : 'estimated';
  const unitPrice =
    power === 'electric' && elRepEurHa != null && elRepKwhHa == null
      ? null
      : power === 'electric'
        ? params.electricity_eur_kwh
        : power === 'diesel'
          ? dieselPrice
          : null;

  const networkFee = record?.network_fee_eur_ha ?? null;
  const networkLine = source === 'network' && (networkFee != null || water > 0);
  const consumables = record?.consumables_eur_ha ?? null;
  const consumablesLine = consumables != null;

  let basis: IrrigationBasis;
  if (source === 'none') basis = 'not_irrigated';
  else if (!(energyLine || networkLine || consumablesLine)) basis = ongoing ? 'ongoing' : 'not_irrigated';
  else if (source === null) basis = 'unknown_source';
  else if ((energyLine && energyCost == null) || (networkLine && networkFee == null)) basis = 'no_reference';
  else if (energyLine && !energyReported) basis = waterBasis === 'reported' ? 'estimated_from_volume' : 'estimated';
  else basis = 'reported';

  const parts: (number | null)[] = [];
  if (energyLine) parts.push(energyCost == null ? null : round2(energyCost));
  if (networkLine) parts.push(networkFee == null ? null : round2(networkFee));
  if (consumablesLine) parts.push(round2(consumables!));
  const priced = parts.filter((v): v is number => v !== null);

  return {
    source,
    power,
    method,
    level,
    waterHa,
    waterBasis,
    liftM,
    liftBasis,
    pressureM,
    headM,
    kwhHa,
    litresHa,
    unitPrice,
    energyLine,
    energyBasis,
    energyEurHa: energyLine && energyCost != null ? round2(energyCost) : null,
    networkLine,
    networkEurHa: networkLine && networkFee != null ? round2(networkFee) : null,
    consumablesLine,
    consumablesEurHa: consumablesLine ? round2(consumables!) : null,
    basis,
    totalEurHa: priced.length ? round2(priced.reduce((a, b) => a + b, 0)) : null,
    unpriced: parts.length - priced.length,
    estimated: energyBasis === 'estimated',
  };
}
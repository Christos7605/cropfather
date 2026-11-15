import { supabase } from './supabase';
import { FieldError } from './fields';
import { opt, type Question } from './questionnaire';
import type { IrrigationInput } from './irrigation';

// Per field: each season is one crop, from sowing to harvest (table crop_history), with how it was
// grown, how the harvest went, the fertilisers applied (table fertilizer_applications) and the plant
// protection treatments (table protection_applications).
// Periods of one field never overlap (enforced by the database, checked here first for a clear
// message). harvested_on empty: the crop is still in the field. Every detail is optional;
// 'unknown' is "I don't know"

export type Tillage = 'plough' | 'reduced' | 'noTill' | 'unknown';
export type Residues = 'burn' | 'remove' | 'incorporate' | 'leave' | 'unknown';
export type Nitrogen = 'none' | 'low' | 'normal' | 'high' | 'unknown';
export type SeasonIrrigation = 'none' | 'some' | 'full' | 'unknown';
export type YieldOutcome = 'failed' | 'poor' | 'normal' | 'good' | 'unknown';

export type MainProduct = 'grain' | 'seed_cotton' | 'paddy' | 'seed' | 'hay' | 'none' | 'other';

export interface Crop {
  id: string;
  name_en: string | null;
  name_el: string | null;
  // Usual sowing and harvest month (1-12), used to suggest dates; empty for perennials
  sowing_month: number | null;
  harvest_month: number | null;
  // Regional reference (policy data, coastal zone averages); empty for some crops
  yield_kg_ha: number | null;
  price_eur_kg: number | null;
  // mock: placeholder without a source (see NASA/sources/README.md); shown as approximate
  price_kind: 'market' | 'indicative' | 'mock' | null;
  // What is harvested and sold; 'none' for fallow
  main_product: MainProduct | null;
  // 'straw' when the crop's straw is commonly baled and sold
  byproduct: 'straw' | null;
}

export interface Season {
  id: number;
  field_id: string;
  // Year of harvest (or of sowing while still in the field), kept by the database
  season_year: number;
  crop_id: string;
  // YYYY-MM-DD; empty only for seasons recorded before periods existed
  sown_on: string | null;
  // YYYY-MM-DD; empty while the crop is still in the field
  harvested_on: string | null;
  tillage: Tillage | null;
  residues: Residues | null;
  nitrogen: Nitrogen | null;
  irrigation: SeasonIrrigation | null;
  yield_outcome: YieldOutcome | null;
  notes: string | null;
  // Other costs of this season, per hectare (rent, fuel, machinery). Empty when none.
  extra_cost_eur_ha: number | null;
  updated_at: string;
}

export type SeasonInput = Omit<Season, 'id' | 'field_id' | 'updated_at' | 'season_year'>;

// Detail questions, keyed by crop_history column (reuse the questionnaire inputs)
export const SEASON_DETAILS: (Question & { id: keyof SeasonInput })[] = [
  {
    id: 'tillage',
    type: 'single',
    allowUnknown: true,
    titleKey: 'seasons.q.tillage.title',
    options: [
      opt('plough', 'seasons.q.tillage.plough', 'seasons.q.tillage.ploughDesc'),
      opt('reduced', 'seasons.q.tillage.reduced', 'seasons.q.tillage.reducedDesc'),
      opt('noTill', 'seasons.q.tillage.noTill', 'seasons.q.tillage.noTillDesc'),
    ],
  },
  {
    id: 'residues',
    type: 'single',
    allowUnknown: true,
    titleKey: 'seasons.q.residues.title',
    options: [
      opt('burn', 'seasons.q.residues.burn'),
      opt('remove', 'seasons.q.residues.remove'),
      opt('incorporate', 'seasons.q.residues.incorporate'),
      opt('leave', 'seasons.q.residues.leave'),
    ],
  },
  {
    id: 'nitrogen',
    type: 'single',
    allowUnknown: true,
    titleKey: 'seasons.q.nitrogen.title',
    helpKey: 'seasons.q.nitrogen.help',
    options: [
      opt('none', 'seasons.q.nitrogen.none'),
      opt('low', 'seasons.q.nitrogen.low'),
      opt('normal', 'seasons.q.nitrogen.normal'),
      opt('high', 'seasons.q.nitrogen.high'),
    ],
  },
  {
    id: 'irrigation',
    type: 'single',
    allowUnknown: true,
    titleKey: 'seasons.q.irrigation.title',
    options: [
      opt('none', 'seasons.q.irrigation.none'),
      opt('some', 'seasons.q.irrigation.some'),
      opt('full', 'seasons.q.irrigation.full'),
    ],
  },
  {
    id: 'yield_outcome',
    type: 'single',
    allowUnknown: true,
    titleKey: 'seasons.q.yield.title',
    helpKey: 'seasons.q.yield.help',
    options: [
      opt('failed', 'seasons.q.yield.failed'),
      opt('poor', 'seasons.q.yield.poor'),
      opt('normal', 'seasons.q.yield.normal'),
      opt('good', 'seasons.q.yield.good'),
    ],
  },
];

export const NOTES_MAX = 500;
// A season can last at most this many days (perennials such as alfalfa); same rule as the database
export const MAX_SEASON_DAYS = 2200;

const COLUMNS =
  'id, field_id, season_year, crop_id, sown_on, harvested_on, tillage, residues, nitrogen, irrigation, yield_outcome, notes, extra_cost_eur_ha, updated_at';

// Other costs (rent, fuel, machinery) asked per stremma. The database stores euros per hectare.
export const EXTRA_COST_MAX_STREMMA = 2000;

const fail = (error: { code?: string | null; message: string }) => new FieldError(error.code ?? null, error.message);

export async function listCrops(): Promise<Crop[]> {
  const { data, error } = await supabase
    .from('crops')
    .select('id, name_en, name_el, sowing_month, harvest_month, yield_kg_ha, price_eur_kg, price_kind, main_product, byproduct');
  if (error) throw fail(error);
  return (data ?? []) as Crop[];
}

export async function listSeasons(fieldId: string): Promise<Season[]> {
  const { data, error } = await supabase.from('crop_history').select(COLUMNS).eq('field_id', fieldId);
  if (error) throw fail(error);
  return sortSeasons((data ?? []) as Season[]);
}

// Newest first: by sowing date, seasons without dates by their year
export function sortSeasons(list: Season[]): Season[] {
  const key = (s: Season) => s.sown_on ?? `${s.season_year}-00-00`;
  return [...list].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : b.id - a.id));
}

/**
 * Saves a season, its seed, its fertilisers, its plant protection treatments and its income in one
 * transaction (database function save_season) and returns the saved season. income null leaves the
 * stored income as it is. Error codes: 23P01 the period
 * overlaps another season of the field, 23514 a value out of range, P0002 the season no longer
 * exists
 */
export async function saveSeason(
  fieldId: string,
  input: SeasonInput,
  applications: ApplicationInput[],
  protections: ProtectionInput[],
  income: IncomeInput | null,
  seeds: SeedInput[],
  irrigation: IrrigationInput | null,
  id?: number,
): Promise<Season> {
  const season = { ...input, notes: input.notes?.trim() ? input.notes.trim().slice(0, NOTES_MAX) : null };
  const { data, error } = await supabase.rpc('save_season', {
    p_field_id: fieldId,
    p_season: season,
    p_applications: applications,
    p_id: id ?? null,
    p_protections: protections,
    p_income: income,
    p_seeds: seeds,
    p_irrigation: irrigation,
  });
  if (error) throw fail(error);
  const { data: row, error: readError } = await supabase
    .from('crop_history')
    .select(COLUMNS)
    .eq('id', data as number)
    .single();
  if (readError) throw fail(readError);
  return row as Season;
}

export async function deleteSeason(id: number): Promise<void> {
  const { error } = await supabase.from('crop_history').delete().eq('id', id);
  if (error) throw fail(error);
}

// Crop name in the current language, with sensible fallbacks
export function cropName(crop: Crop | undefined, language: 'el' | 'en', fallback: string): string {
  if (!crop) return fallback;
  return (language === 'el' ? crop.name_el : crop.name_en) ?? crop.name_en ?? crop.name_el ?? crop.id;
}

// Periods
// Today in local time as YYYY-MM-DD
export function todayIso(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

// Whole days from a to b (YYYY-MM-DD), independent of time zones
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

// Length of a period in months, rounded (at least 1)
export function monthsBetween(a: string, b: string): number {
  return Math.max(1, Math.round(daysBetween(a, b) / 30.44));
}

/**
 * Two periods overlap when each starts before the other ends. The harvest day itself is free
 * (a crop may be sown the day the previous one was harvested); no harvest date means "still in
 * the field", which reaches to the future. Same rule as the database constraint
 */
export function periodsOverlap(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string | null,
): boolean {
  return (bEnd === null || aStart < bEnd) && (aEnd === null || bStart < aEnd);
}

// The first other season of the field whose period overlaps the given one, if any
export function findOverlap(
  start: string,
  end: string | null,
  seasons: Season[],
  selfId?: number,
): Season | null {
  return (
    seasons.find(
      (s) => s.id !== selfId && s.sown_on !== null && periodsOverlap(start, end, s.sown_on, s.harvested_on),
    ) ?? null
  );
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Dates to suggest for a crop, from its usual calendar: the most recent season that has already
 * been harvested and does not overlap the field's other seasons (sown on the 1st of the usual
 * month, harvested on the 20th). Null when the crop has no usual calendar or nothing fits.
 */
export function suggestPeriod(
  crop: Crop | undefined,
  seasons: Season[],
  selfId?: number,
  today = todayIso(),
): { sown_on: string; harvested_on: string } | null {
  if (!crop?.sowing_month || !crop.harvest_month) return null;
  const sm = crop.sowing_month;
  const hm = crop.harvest_month;
  const thisYear = Number(today.slice(0, 4));
  for (let year = thisYear; year > thisYear - 15; year--) {
    const harvested_on = iso(year, hm, 20);
    if (harvested_on > today) continue;
    const sown_on = iso(sm > hm ? year - 1 : year, sm, 1);
    if (!findOverlap(sown_on, harvested_on, seasons, selfId)) return { sown_on, harvested_on };
  }
  return null;
}

// Fertilisers
export type FertMethod = 'basal' | 'topdress' | 'fertigation' | 'foliar';
export const FERT_METHODS: FertMethod[] = ['basal', 'topdress', 'fertigation', 'foliar'];

// Analysis columns, as printed on the bag (% by weight)
export const NUTRIENTS = ['n_pct', 'p2o5_pct', 'k2o_pct', 'so3_pct', 'cao_pct', 'mgo_pct'] as const;
export type Nutrient = (typeof NUTRIENTS)[number];
// Forms of the total nitrogen (ammoniacal, nitrate, ureic): parts of n_pct, never more than it
export const N_FORMS = ['n_nh4_pct', 'n_no3_pct', 'n_urea_pct'] as const;
export type NForm = (typeof N_FORMS)[number];
export type AnalysisKey = Nutrient | NForm;
export const ANALYSIS_KEYS: readonly AnalysisKey[] = [...NUTRIENTS, ...N_FORMS];
export type Analysis = Record<AnalysisKey, number | null>;
// Labels round each figure, so the forms may exceed the total by this much (same as the database)
export const N_FORMS_ROUNDING = 0.2;

export interface FertilizerProduct extends Analysis {
  id: number;
  name: string;
  brand: string | null;
  form: string;
  micro: string | null;
}

// One application as stored (rate per hectare)
export interface FertilizerApplication extends Analysis {
  id: number;
  season_id: number;
  product_id: number | null;
  product_name: string;
  rate_kg_ha: number | null;
  price_eur_kg: number | null;
  method: FertMethod | null;
  applied_on: string | null;
  // Spread by a contractor or a hired worker
  contractor: boolean;
  // What that work cost per hectare
  contractor_eur_ha: number | null;
  position: number;
}

// What save_season receives for one application
export type ApplicationInput = Omit<FertilizerApplication, 'id' | 'season_id' | 'position'>;

// The app asks per stremma (0.1 ha), the database stores per hectare
export const STREMMA_PER_HA = 10;

// Rounds euros to the cent, half away from zero, like Postgres round(x, 2) on numeric. Binary
// floats put 41.965 a hair below the half, so a millionth of a cent is added first
export function roundCents(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-6)) / 100;
}

// € per hectare to € per stremma, rounded like the views do (round(x / 10, 2))
export function perStremmaEur(eurHa: number): number {
  return roundCents(eurHa / STREMMA_PER_HA);
}
export const MAX_RATE_KG_STREMMA = 500;
export const MAX_PRICE_EUR_KG = 100;

export async function listFertilizerProducts(): Promise<FertilizerProduct[]> {
  const { data, error } = await supabase
    .from('fertilizer_products')
    .select('id, name, brand, form, micro, n_pct, p2o5_pct, k2o_pct, so3_pct, cao_pct, mgo_pct, n_nh4_pct, n_no3_pct, n_urea_pct')
    .eq('active', true)
    .order('name');
  if (error) throw fail(error);
  return (data ?? []) as FertilizerProduct[];
}

export async function listApplications(seasonIds: number[]): Promise<FertilizerApplication[]> {
  if (seasonIds.length === 0) return [];
  const { data, error } = await supabase
    .from('fertilizer_applications')
    .select(
      'id, season_id, product_id, product_name, n_pct, p2o5_pct, k2o_pct, so3_pct, cao_pct, mgo_pct, n_nh4_pct, n_no3_pct, n_urea_pct, rate_kg_ha, price_eur_kg, method, applied_on, contractor, contractor_eur_ha, position',
    )
    .in('season_id', seasonIds)
    .order('position');
  if (error) throw fail(error);
  return (data ?? []) as FertilizerApplication[];
}

// Kilograms of a nutrient per stremma delivered by an application (null when unknown)
export function nutrientKgPerStremma(app: Pick<FertilizerApplication, 'rate_kg_ha'> & Analysis, n: AnalysisKey): number | null {
  const pct = app[n];
  if (app.rate_kg_ha == null || pct == null) return null;
  return (app.rate_kg_ha / STREMMA_PER_HA) * (pct / 100);
}

// Plant protection
export type ProtectionType =
  | 'herbicide'
  | 'fungicide'
  | 'insecticide'
  | 'acaricide'
  | 'molluscicide'
  | 'nematicide'
  | 'growth_regulator'
  | 'other';
export const PROTECTION_TYPES: ProtectionType[] = [
  'herbicide',
  'fungicide',
  'insecticide',
  'acaricide',
  'molluscicide',
  'nematicide',
  'growth_regulator',
  'other',
];

// Formulation codes as printed after the product name; liquids are counted in litres, solids in kg
export const LIQUID_FORMULATIONS = ['EC', 'EW', 'ME', 'SC', 'SE', 'CS', 'OD', 'SL', 'DC', 'FS'] as const;
export const SOLID_FORMULATIONS = ['WG', 'WP', 'SG', 'SP', 'GR', 'GB'] as const;
export type Formulation = (typeof LIQUID_FORMULATIONS)[number] | (typeof SOLID_FORMULATIONS)[number] | 'other';
export const FORMULATIONS: Formulation[] = [...LIQUID_FORMULATIONS, ...SOLID_FORMULATIONS, 'other'];
export type ProductUnit = 'l' | 'kg';

export function unitOfFormulation(f: Formulation | null): ProductUnit | null {
  if (!f) return null;
  if ((LIQUID_FORMULATIONS as readonly string[]).includes(f)) return 'l';
  if ((SOLID_FORMULATIONS as readonly string[]).includes(f)) return 'kg';
  return null;
}

export type ProtectionMethod = 'sprayer' | 'knapsack' | 'spreader' | 'seed' | 'other';
export const PROTECTION_METHODS: ProtectionMethod[] = ['sprayer', 'knapsack', 'spreader', 'seed', 'other'];

export interface ProtectionProduct {
  id: number;
  name: string;
  brand: string | null;
  product_type: ProtectionType;
  formulation: Formulation | null;
  unit: ProductUnit;
  active_substances: string | null;
  authorisation_no: string | null;
}

// One treatment as stored (dose and fee per hectare)
export interface ProtectionApplication {
  id: number;
  season_id: number;
  product_id: number | null;
  product_name: string;
  product_type: ProtectionType;
  formulation: Formulation | null;
  unit: ProductUnit;
  active_substances: string | null;
  // What it was for: weeds, a disease, a pest
  target: string | null;
  // Litres or kg of product per hectare
  dose_per_ha: number | null;
  // € per litre or per kg of product
  price_eur_unit: number | null;
  method: ProtectionMethod | null;
  applied_on: string | null;
  // Done by a contractor or a hired worker
  contractor: boolean;
  // What that work cost per hectare
  contractor_eur_ha: number | null;
  position: number;
}

// What save_season receives for one treatment
export type ProtectionInput = Omit<ProtectionApplication, 'id' | 'season_id' | 'position'>;

// The app asks the dose in ml or g per stremma: 1 l/ha = 100 ml/stremma
export const ML_PER_STREMMA_PER_L_HA = 100;
export const MAX_DOSE_PER_STREMMA = 20_000; // ml or g (= 200 l or kg per ha)
export const MAX_PRICE_EUR_UNIT = 2000;
export const MAX_FEE_EUR_STREMMA = 100;
export const TARGET_MAX = 120;
export const SUBSTANCES_MAX = 300;

export async function listProtectionProducts(): Promise<ProtectionProduct[]> {
  const { data, error } = await supabase
    .from('protection_products')
    .select('id, name, brand, product_type, formulation, unit, active_substances, authorisation_no')
    .eq('active', true)
    .order('name');
  if (error) throw fail(error);
  return (data ?? []) as ProtectionProduct[];
}

export async function listProtections(seasonIds: number[]): Promise<ProtectionApplication[]> {
  if (seasonIds.length === 0) return [];
  const { data, error } = await supabase
    .from('protection_applications')
    .select(
      'id, season_id, product_id, product_name, product_type, formulation, unit, active_substances, target, dose_per_ha, price_eur_unit, method, applied_on, contractor, contractor_eur_ha, position',
    )
    .in('season_id', seasonIds)
    .order('position');
  if (error) throw fail(error);
  return (data ?? []) as ProtectionApplication[];
}

// Season costs (same rules as the database view season_finance)
/**
 * Input costs of a season per stremma: seed and fertilisers (rate x price), plant protection
 * products (dose x price), contractor fees (sowing, fertilising, spraying) and irrigation (from
 * irrigationCost in lib/irrigation.ts: its priced total per ha and the parts it could not price). Items without a price are left out and counted in
 * `unpriced`; `total` is null when nothing has a price
 */
export function seasonCostPerStremma(
  ferts: Pick<FertilizerApplication, 'rate_kg_ha' | 'price_eur_kg' | 'contractor' | 'contractor_eur_ha'>[],
  prots: Pick<ProtectionApplication, 'dose_per_ha' | 'price_eur_unit' | 'contractor' | 'contractor_eur_ha'>[],
  seeds: Pick<SeedApplication, 'rate_kg_ha' | 'price_eur_kg' | 'contractor' | 'contractor_eur_ha'>[] = [],
  irrigationCostHa: { totalEurHa: number | null; unpriced: number } | null = null,
  extraEurHa: number | null = null,
): {
  seed: number | null;
  irrigation: number | null;
  fertilizers: number | null;
  protection: number | null;
  work: number | null;
  total: number | null;
  // The same total per hectare, as the view season_finance has it (total_cost_eur_ha)
  totalHa: number | null;
  unpriced: number;
} {
  let unpriced = 0;
  // Each line rounded to the cent per hectare, like season_cost_lines.cost_eur_ha
  const add = (sum: number | null, v: number | null) => {
    if (v === null) {
      unpriced += 1;
      return sum;
    }
    return (sum ?? 0) + roundCents(v);
  };
  let fertilizers: number | null = null;
  let work: number | null = null;
  for (const f of ferts) {
    fertilizers = add(fertilizers, f.rate_kg_ha != null && f.price_eur_kg != null ? f.rate_kg_ha * f.price_eur_kg : null);
    if (f.contractor) work = add(work, f.contractor_eur_ha);
  }
  let seed: number | null = null;
  for (const sd of seeds) {
    seed = add(seed, sd.rate_kg_ha != null && sd.price_eur_kg != null ? sd.rate_kg_ha * sd.price_eur_kg : null);
    if (sd.contractor) work = add(work, sd.contractor_eur_ha);
  }
  let protection: number | null = null;
  for (const p of prots) {
    protection = add(protection, p.dose_per_ha != null && p.price_eur_unit != null ? p.dose_per_ha * p.price_eur_unit : null);
    if (p.contractor) work = add(work, p.contractor_eur_ha);
  }
  const irrigation = irrigationCostHa?.totalEurHa ?? null;
  unpriced += irrigationCostHa?.unpriced ?? 0;
  const extra = extraEurHa != null && extraEurHa > 0 ? roundCents(extraEurHa) : null;
  const parts = [seed, fertilizers, protection, work, irrigation, extra].filter((v): v is number => v !== null);
  const perStremma = (v: number | null) => (v === null ? null : perStremmaEur(v));
  return {
    seed: perStremma(seed),
    irrigation: perStremma(irrigation),
    fertilizers: perStremma(fertilizers),
    protection: perStremma(protection),
    work: perStremma(work),
    total: parts.length ? perStremma(parts.reduce((a, b) => a + b, 0)) : null,
    totalHa: parts.length ? roundCents(parts.reduce((a, b) => a + b, 0)) : null,
    unpriced,
  };
}

// Income (table season_income, view season_finance)
// One row per season; figures per hectare. disclosed false: the farmer prefers not to say
export interface SeasonIncome {
  season_id: number;
  disclosed: boolean;
  main_kg_ha: number | null;
  main_moisture_pct: number | null;
  main_price_eur_kg: number | null;
  straw_kg_ha: number | null;
  straw_moisture_pct: number | null;
  straw_price_eur_kg: number | null;
  subsidy_eur_ha: number | null;
  other_income_eur_ha: number | null;
}

export type IncomeInput = Omit<SeasonIncome, 'season_id'>;

// Limits per stremma, as the app asks them (the database checks the same per hectare)
export const INCOME_LIMITS = {
  mainKg: 3000,
  moisture: 90,
  mainPrice: 20,
  strawKg: 1500,
  strawPrice: 2,
  subsidy: 500,
  other: 1000,
} as const;

export type YieldFactors = Record<YieldOutcome, number>;
// Used only if the factor table cannot be read; same starting values as the database
export const DEFAULT_YIELD_FACTORS: YieldFactors = { failed: 0.2, poor: 0.7, normal: 1, good: 1.2, unknown: 1 };

const INCOME_COLUMNS =
  'season_id, disclosed, main_kg_ha, main_moisture_pct, main_price_eur_kg, straw_kg_ha, straw_moisture_pct, straw_price_eur_kg, subsidy_eur_ha, other_income_eur_ha';

export async function listIncome(seasonIds: number[]): Promise<SeasonIncome[]> {
  if (seasonIds.length === 0) return [];
  const { data, error } = await supabase.from('season_income').select(INCOME_COLUMNS).in('season_id', seasonIds);
  if (error) throw fail(error);
  return (data ?? []) as SeasonIncome[];
}

export async function listYieldFactors(): Promise<YieldFactors> {
  const { data, error } = await supabase.from('yield_outcome_factors').select('outcome, factor');
  if (error) throw fail(error);
  const factors = { ...DEFAULT_YIELD_FACTORS };
  for (const row of (data ?? []) as { outcome: YieldOutcome; factor: number }[]) factors[row.outcome] = Number(row.factor);
  return factors;
}

export type RevenueBasis =
  | 'reported'
  | 'partly_estimated'
  | 'estimated_from_outcome'
  | 'estimated_baseline'
  | 'no_reference'
  | 'no_harvest'
  | 'ongoing';

export interface Revenue {
  basis: RevenueBasis;
  // Figures used for the main product, per hectare; null when unknown
  mainKgHa: number | null;
  mainPrice: number | null;
  // Each part per hectare
  main: number | null;
  straw: number | null;
  subsidy: number | null;
  other: number | null;
  // main + straw + aid + other, per hectare; null when it cannot be worked out
  revenue: number | null;
  // revenue minus the recorded costs, per hectare
  margin: number | null;
  // The factor applied to the regional yield
  factor: number;
}

/**
 * Revenue and margin of a season per hectare. Same rules as the view season_finance:
 * a main-product figure the farmer did not give is estimated from the crop's regional reference
 * (yield x the factor of "how did the harvest go", and price); straw counts only with both
 * quantity and price; aid and other income count as given
 */
export function seasonRevenue(
  season: Pick<Season, 'sown_on' | 'harvested_on' | 'yield_outcome'>,
  crop: Crop | undefined,
  income: IncomeInput | null,
  factors: YieldFactors,
  costPerHa: number | null,
): Revenue {
  const factor = factors[season.yield_outcome ?? 'unknown'] ?? 1;
  const open = Boolean(season.sown_on && !season.harvested_on);
  const shared = income?.disclosed ?? true;
  const q = shared ? income?.main_kg_ha ?? null : null;
  const p = shared ? income?.main_price_eur_kg ?? null : null;
  const refQ = crop?.yield_kg_ha != null ? crop.yield_kg_ha * factor : null;
  const refP = crop?.price_eur_kg ?? null;

  let basis: RevenueBasis;
  if (open) basis = 'ongoing';
  else if (crop?.main_product === 'none') basis = 'no_harvest';
  else if (q !== null && p !== null) basis = 'reported';
  else if ((q ?? refQ) === null || (p ?? refP) === null) basis = 'no_reference';
  else if (q !== null || p !== null) basis = 'partly_estimated';
  else if ((season.yield_outcome ?? 'unknown') !== 'unknown') basis = 'estimated_from_outcome';
  else basis = 'estimated_baseline';

  const empty = { mainKgHa: null, mainPrice: null, main: null, straw: null, subsidy: null, other: null, revenue: null, margin: null };
  if (basis === 'ongoing') return { basis, factor, ...empty };

  const round2 = roundCents;
  const mainKgHa = basis === 'no_reference' ? null : basis === 'no_harvest' ? 0 : (q ?? refQ)!;
  const mainPrice = basis === 'no_reference' ? null : basis === 'no_harvest' ? 0 : (p ?? refP)!;
  const main = mainKgHa === null || mainPrice === null ? null : mainKgHa * mainPrice;
  const straw =
    shared && income?.straw_kg_ha != null && income.straw_price_eur_kg != null ? round2(income.straw_kg_ha * income.straw_price_eur_kg) : 0;
  const subsidy = shared ? income?.subsidy_eur_ha ?? 0 : 0;
  const other = shared ? income?.other_income_eur_ha ?? 0 : 0;
  const revenue = main === null ? null : round2(main + straw + subsidy + other);
  const margin = revenue === null ? null : round2(revenue - (costPerHa ?? 0));
  return { basis, factor, mainKgHa, mainPrice, main: main === null ? null : round2(main), straw, subsidy, other, revenue, margin };
}

// Seed (tables seed_varieties, seed_applications)
export interface SeedVariety {
  id: number;
  crop_id: string;
  name: string;
  breeder: string | null;
}

export type SeedOrigin = 'certified' | 'uncertified' | 'own';
export const SEED_ORIGINS: SeedOrigin[] = ['certified', 'uncertified', 'own'];
export type SeedMethod = 'drill' | 'precision' | 'broadcast' | 'other';
export const SEED_METHODS: SeedMethod[] = ['drill', 'precision', 'broadcast', 'other'];

// One seed line of a season, as stored (rate and fee per hectare)
export interface SeedApplication {
  id: number;
  season_id: number;
  variety_id: number | null;
  // The crop this seed is: the season's crop, or a component of a mixture
  crop_id: string | null;
  // Empty when the variety is not known
  variety_name: string | null;
  origin: SeedOrigin | null;
  rate_kg_ha: number | null;
  price_eur_kg: number | null;
  method: SeedMethod | null;
  sown_on: string | null;
  contractor: boolean;
  contractor_eur_ha: number | null;
  position: number;
}

export type SeedInput = Omit<SeedApplication, 'id' | 'season_id' | 'position'>;

export const MAX_SEED_KG_STREMMA = 60;
export const MAX_SEED_PRICE_EUR_KG = 100;

// Mixtures are sown from the seed of their components
export const MIXTURE_PARTS: Record<string, string[]> = { vetch_oat: ['vetch', 'oat'] };
// The crops whose seed a season of this crop uses
export const seedCropsOf = (cropId: string): string[] => MIXTURE_PARTS[cropId] ?? [cropId];

export async function listSeedVarieties(): Promise<SeedVariety[]> {
  const { data, error } = await supabase
    .from('seed_varieties')
    .select('id, crop_id, name, breeder')
    .eq('active', true)
    .order('name');
  if (error) throw fail(error);
  return (data ?? []) as SeedVariety[];
}

export async function listSeeds(seasonIds: number[]): Promise<SeedApplication[]> {
  if (seasonIds.length === 0) return [];
  const { data, error } = await supabase
    .from('seed_applications')
    .select(
      'id, season_id, variety_id, crop_id, variety_name, origin, rate_kg_ha, price_eur_kg, method, sown_on, contractor, contractor_eur_ha, position',
    )
    .in('season_id', seasonIds)
    .order('position');
  if (error) throw fail(error);
  return (data ?? []) as SeedApplication[];
}

// Season results of a field, from the database view season_finance (Overview tab)
export interface SeasonResult {
  season_id: number;
  crop_id: string;
  season_year: number;
  sown_on: string | null;
  harvested_on: string | null;
  ongoing: boolean;
  revenue_basis: RevenueBasis;
  revenue_eur_stremma: number | null;
  total_cost_eur_stremma: number | null;
  margin_eur_stremma: number | null;
}

export async function listSeasonResults(fieldId: string): Promise<SeasonResult[]> {
  const { data, error } = await supabase
    .from('season_finance')
    .select(
      'season_id, crop_id, season_year, sown_on, harvested_on, ongoing, revenue_basis, revenue_eur_stremma, total_cost_eur_stremma, margin_eur_stremma',
    )
    .eq('field_id', fieldId);
  if (error) throw fail(error);
  const rows = ((data ?? []) as SeasonResult[]).map((r) => ({
    ...r,
    revenue_eur_stremma: r.revenue_eur_stremma == null ? null : Number(r.revenue_eur_stremma),
    total_cost_eur_stremma: r.total_cost_eur_stremma == null ? null : Number(r.total_cost_eur_stremma),
    margin_eur_stremma: r.margin_eur_stremma == null ? null : Number(r.margin_eur_stremma),
  }));
  const key = (r: SeasonResult) => r.sown_on ?? `${r.season_year}-00-00`;
  return rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : b.season_id - a.season_id));
}
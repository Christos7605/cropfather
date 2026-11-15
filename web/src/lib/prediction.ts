// One running request per account, remembered in this browser until it is cancelled
// or the four results are shown. NDVI and the model both follow prediction_runs.
// See docs/prediction-pipeline.md.

import { supabase } from './supabase';

const keyFor = (userId: string) => `fieldshift.prediction.${userId}`;

/** Local calendar day as YYYY-MM-DD, the same shape as model_data.coords.end. */
export function localDateStamp(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Remember the day this field was sent for prediction. model_data.coords.end reads it. */
export async function recordPredictionRequest(fieldId: string): Promise<void> {
  const { error } = await supabase
    .from('fields')
    .update({ prediction_requested_on: localDateStamp() })
    .eq('id', fieldId);
  if (error) throw new Error(error.message);
}

export type PredictionStatus =
  | 'ndvi'
  | 'running'
  | 'needs_override'
  | 'failed'
  | 'cancelled'
  | 'predict'
  | 'scoring'
  | 'done';

/** local: the terminal worker. github: one Actions run, started by dispatch-ndvi. */
export type PredictionVia = 'local' | 'github';

/** A GitHub check still waiting after this is cancelled. The queue and install take longer than the heartbeat. */
export const GITHUB_NDVI_WAIT_MS = 25 * 60 * 1000;

/** A GitHub model run still in predict or scoring after this is cancelled. */
export const GITHUB_PREDICT_WAIT_MS = 60 * 60 * 1000;

/** One scored recommendation. type "mix" is the balanced choice. crop is a crop id. */
export interface PredictionOption {
  type: string;
  title?: string;
  crop: string | null;
  why?: string;
  comment?: string;
  scores_pct?: Record<string, number | null> | null;
  economics_eur_ha?: Record<string, number | string | null> | null;
  water?: Record<string, number | null> | null;
  nitrogen_kg_ha?: number | null;
  comments?: string[];
  warnings?: string[];
  also_best_for?: string[];
}

export interface PredictionRank {
  crop: string;
  overall_pct?: number | null;
  economic_pct?: number | null;
  environmental_pct?: number | null;
  margin_eur_ha?: number | null;
}

/** The recommendations object predictor_model.py writes. Older rows only have the four names. */
export interface PredictionResults {
  environmental?: string | null;
  economic?: string | null;
  current?: string | null;
  mixed?: string | null;
  confidence_pct?: number | null;
  field?: {
    centre?: Array<number | null> | null;
    run_date?: string | null;
    coming_season?: string | null;
    climate_window?: string | null;
    climate_years?: string | number | null;
  } | null;
  inputs?: Record<string, { value?: unknown; source?: string | null }> | null;
  weights?: {
    parts?: Record<string, number | null> | null;
    environment?: Record<string, number | null> | null;
    risk_weight?: number | null;
    water_price_eur_m3?: number | null;
  } | null;
  options?: PredictionOption[] | null;
  ranking?: PredictionRank[] | null;
  removed_by_pruning?: Record<string, string[]> | null;
  notes?: string[] | null;
}

export interface PredictionRun {
  id: string;
  status: PredictionStatus;
  via: PredictionVia;
  vegetated: boolean | null;
  observed_on: string | null;
  error: string | null;
  results: PredictionResults | null;
  created_at: string;
}

/** Open a request. The terminal worker claims via=local. GitHub claims the one via=github row it was given. */
export async function startPredictionRun(fieldId: string, via: PredictionVia): Promise<string> {
  const { data, error } = await supabase
    .from('prediction_runs')
    .insert({ field_id: fieldId, status: 'ndvi', via })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function loadPredictionRun(runId: string): Promise<PredictionRun | null> {
  const { data, error } = await supabase
    .from('prediction_runs')
    .select('id, status, via, vegetated, observed_on, error, results, created_at')
    .eq('id', runId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PredictionRun | null) ?? null;
}

/** Ask the Edge Function to start one GitHub Actions run for this row. */
export async function dispatchNdvi(runId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('dispatch-ndvi', { body: { run_id: runId } });
  if (error) throw new Error(error.message);
}

export async function dispatchPredict(runId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('dispatch-predict', { body: { run_id: runId } });
  if (error) throw new Error(error.message);
}

export function githubWaitExpired(createdAt: string, now = Date.now()): boolean {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return false;
  return now - started >= GITHUB_NDVI_WAIT_MS;
}

export function githubPredictExpired(createdAt: string, now = Date.now()): boolean {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return false;
  return now - started >= GITHUB_PREDICT_WAIT_MS;
}

/** True when the NDVI worker has written a heartbeat in the last 20 seconds. */
export async function predictionWorkerLive(): Promise<boolean> {
  const { data, error } = await supabase.rpc('prediction_worker_live');
  if (error) return false;
  return data === true;
}

/** True when the model worker has written a heartbeat in the last 20 seconds. */
export async function predictionPredictorLive(): Promise<boolean> {
  const { data, error } = await supabase.rpc('prediction_predictor_live');
  if (error) return false;
  return data === true;
}

/** cancel, override, or finish. The database refuses any other move. */
export async function choosePrediction(runId: string, choice: 'cancel' | 'override' | 'finish'): Promise<void> {
  const { error } = await supabase.rpc('farmer_set_prediction', { p_run_id: runId, p_choice: choice });
  if (error) throw new Error(error.message);
}

export const PREDICTION_KINDS = ['environment', 'financial', 'current', 'balanced'] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];

export interface RunningPrediction {
  fieldId: string;
  startedAt: string;
  runId: string;
}

export function loadRunningPrediction(userId: string): RunningPrediction | null {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RunningPrediction>;
    if (!parsed || typeof parsed.fieldId !== 'string' || !parsed.fieldId) return null;
    if (typeof parsed.runId !== 'string' || !parsed.runId) return null;
    return {
      fieldId: parsed.fieldId,
      runId: parsed.runId,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

export function saveRunningPrediction(userId: string, fieldId: string, runId: string): RunningPrediction {
  const running: RunningPrediction = { fieldId, runId, startedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(running));
  } catch {
    // The choice still applies for this page load if storage is blocked.
  }
  return running;
}

export function clearRunningPrediction(userId: string): void {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // A blocked storage write still leaves this page able to leave the request.
  }
}

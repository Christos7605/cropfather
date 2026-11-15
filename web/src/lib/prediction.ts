// One running request per account, remembered in this browser until it is cancelled
// or the four results are shown. The NDVI phase follows prediction_runs; the 20 second
// wait still stands in for the prediction model. See docs/prediction-pipeline.md.

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

// The prediction phase is still a placeholder. The NDVI phase waits for the worker.
export const PREDICTION_TIMINGS = {
  predictionMs: 20_000,
} as const;

export type PredictionStatus =
  | 'ndvi'
  | 'running'
  | 'needs_override'
  | 'failed'
  | 'cancelled'
  | 'predict'
  | 'done';

/** local: the terminal worker. github: one Actions run, started by dispatch-ndvi. */
export type PredictionVia = 'local' | 'github';

/** A GitHub check still waiting after this is cancelled. The queue and install take longer than the heartbeat. */
export const GITHUB_NDVI_WAIT_MS = 25 * 60 * 1000;

export interface PredictionRun {
  id: string;
  status: PredictionStatus;
  via: PredictionVia;
  vegetated: boolean | null;
  observed_on: string | null;
  error: string | null;
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
    .select('id, status, via, vegetated, observed_on, error, created_at')
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

export function githubWaitExpired(createdAt: string, now = Date.now()): boolean {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return false;
  return now - started >= GITHUB_NDVI_WAIT_MS;
}

/** True when the NDVI worker has written a heartbeat in the last 20 seconds. */
export async function predictionWorkerLive(): Promise<boolean> {
  const { data, error } = await supabase.rpc('prediction_worker_live');
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

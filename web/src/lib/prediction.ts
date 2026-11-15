// One running request per account, remembered in this browser until it is cancelled
// or the four results are shown. The timed steps stand in for the NDVI check and the
// prediction model; see docs/prediction-pipeline.md for the calls that will replace them.

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

// Placeholder waits. The first NDVI wait always ends in the vegetation warning.
// Confirming the field is empty continues that step, then the prediction step runs.
export const PREDICTION_TIMINGS = {
  ndviMs: 5_000,
  ndviAfterOverrideMs: 3_000,
  predictionMs: 20_000,
} as const;

export const PREDICTION_KINDS = ['environment', 'financial', 'current', 'balanced'] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];

export interface RunningPrediction {
  fieldId: string;
  startedAt: string;
}

export function loadRunningPrediction(userId: string): RunningPrediction | null {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RunningPrediction>;
    if (!parsed || typeof parsed.fieldId !== 'string' || !parsed.fieldId) return null;
    return { fieldId: parsed.fieldId, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
  } catch {
    return null;
  }
}

export function saveRunningPrediction(userId: string, fieldId: string): RunningPrediction {
  const running: RunningPrediction = { fieldId, startedAt: new Date().toISOString() };
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

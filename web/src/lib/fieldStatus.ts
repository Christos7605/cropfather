import { supabase } from './supabase';
import { FieldError, type FieldRecord } from './fields';
import { FIELD_QUESTIONNAIRE, countedQuestions } from './questionnaire';
import { DEPTH_KINDS, type WaterPointKind } from './waterPoints';

// What is known and what is still missing for each field: used by the dashboard (list, next
// steps) and by the field page (field data card). Everything is computed in the browser from
// my_fields and crop_history, so no extra database objects are needed

// One season of one field, as needed for the summaries (crop_history, own rows only)
export interface SeasonBrief {
  field_id: string;
  season_year: number;
  crop_id: string;
  // Empty for seasons recorded before periods existed
  sown_on: string | null;
  // Empty while the crop is still in the field
  harvested_on: string | null;
}

// Seasons of all the farmer's fields, or of one field, newest first
export async function listMySeasons(fieldId?: string): Promise<SeasonBrief[]> {
  let query = supabase.from('crop_history').select('field_id, season_year, crop_id, sown_on, harvested_on');
  if (fieldId) query = query.eq('field_id', fieldId);
  const { data, error } = await query.order('season_year', { ascending: false });
  if (error) throw new FieldError(error.code ?? null, error.message);
  return (data ?? []) as SeasonBrief[];
}

// The field from my_fields, or null when it does not exist (or is not the farmer's)
export async function getMyField(id: string): Promise<FieldRecord | null> {
  const { data, error } = await supabase.from('my_fields').select('*').eq('id', id).maybeSingle();
  if (error) throw new FieldError(error.code ?? null, error.message);
  return (data as FieldRecord | null) ?? null;
}

// The most recent season a farmer can already record. Winter cereals are harvested by July and
// summer crops from September, so from August on the current year counts, before that last year
export function latestHarvestYear(now = new Date()): number {
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

export interface SurveyProgress {
  state: 'notStarted' | 'inProgress' | 'done';
  answered: number;
  total: number;
}

// Progress of the field questionnaire. Answers to an older question set count as not started
export function surveyProgress(field: FieldRecord): SurveyProgress {
  const totalNow = countedQuestions(FIELD_QUESTIONNAIRE).length;
  if (field.survey_version !== FIELD_QUESTIONNAIRE.version || !field.survey_status) {
    return { state: 'notStarted', answered: 0, total: totalNow };
  }
  const answered = Math.min(field.survey_answered ?? 0, totalNow);
  const coversCurrent = (field.survey_total ?? 0) >= totalNow && answered >= totalNow;
  return {
    state: field.survey_status === 'submitted' && coversCurrent ? 'done' : 'inProgress',
    answered,
    total: totalNow,
  };
}

// Seasons of one field, newest first (by sowing date; seasons without dates by their year)
export const seasonsOf = (seasons: SeasonBrief[], fieldId: string) => {
  const key = (s: SeasonBrief) => s.sown_on ?? `${s.season_year}-00-00`;
  return seasons.filter((s) => s.field_id === fieldId).sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
};

// The crop history is up to date: a crop is in the field now, or the latest harvest is recent
export function historyCurrent(seasons: SeasonBrief[], fieldId: string): boolean {
  const own = seasonsOf(seasons, fieldId);
  if (own.some((s) => s.sown_on && !s.harvested_on)) return true;
  const latest = own.reduce((max, s) => Math.max(max, s.season_year), -Infinity);
  return latest >= latestHarvestYear();
}

// A field needs a water source when it is irrigated; rainfed fields usually have none
export const needsWaterSource = (field: FieldRecord) => field.irrigation !== 'rainfed';

// The linked water point is a borehole or well whose depth has not been given
export const missingDepth = (field: FieldRecord) =>
  field.water_point_id != null &&
  DEPTH_KINDS.includes((field.well_kind ?? 'unknown') as WaterPointKind) &&
  field.well_depth_m == null;

export type Step = 'boundary' | 'questionnaire' | 'history' | 'water';

// Each piece of field data and whether it is complete. The water source counts only when irrigated
export function fieldSteps(field: FieldRecord, seasons: SeasonBrief[]): { step: Step; done: boolean }[] {
  const steps: { step: Step; done: boolean }[] = [
    { step: 'boundary', done: true },
    { step: 'questionnaire', done: surveyProgress(field).state === 'done' },
    { step: 'history', done: historyCurrent(seasons, field.id) },
  ];
  if (needsWaterSource(field)) steps.push({ step: 'water', done: field.water_point_id != null });
  return steps;
}

// Next steps (dashboard)
export type TodoKind =
  | 'farmProfile'
  | 'firstField'
  | 'waterSource'
  | 'questionnaireStart'
  | 'questionnaireContinue'
  | 'firstSeason'
  | 'latestSeason'
  | 'seasonDates'
  | 'wellDepth';

export interface Todo {
  kind: TodoKind;
  // Where the item leads
  to: string;
  field?: FieldRecord;
  year?: number;
  answered?: number;
  total?: number;
}

export const fieldPath = (id: string, tab?: 'history' | 'questionnaire') =>
  `/fields/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`;

// Missing data, most useful first: farm profile, water source, questionnaire, crop history, depth
export function buildTodos(fields: FieldRecord[], seasons: SeasonBrief[], farmDone: boolean): Todo[] {
  const todos: Todo[] = [];
  if (!farmDone) todos.push({ kind: 'farmProfile', to: '/farm-profile' });
  if (fields.length === 0) {
    todos.push({ kind: 'firstField', to: '/map' });
    return todos;
  }
  const year = latestHarvestYear();
  const water: Todo[] = [];
  const survey: Todo[] = [];
  const history: Todo[] = [];
  const depth: Todo[] = [];
  for (const field of fields) {
    if (needsWaterSource(field) && field.water_point_id == null) {
      water.push({ kind: 'waterSource', to: fieldPath(field.id), field });
    }
    const progress = surveyProgress(field);
    if (progress.state === 'notStarted') {
      survey.push({ kind: 'questionnaireStart', to: `${fieldPath(field.id)}/questionnaire`, field });
    } else if (progress.state === 'inProgress') {
      survey.push({
        kind: 'questionnaireContinue',
        to: `${fieldPath(field.id)}/questionnaire`,
        field,
        answered: progress.answered,
        total: progress.total,
      });
    }
    const own = seasonsOf(seasons, field.id);
    if (own.length === 0) history.push({ kind: 'firstSeason', to: fieldPath(field.id, 'history'), field });
    else if (!historyCurrent(seasons, field.id)) {
      history.push({ kind: 'latestSeason', to: fieldPath(field.id, 'history'), field, year });
    }
    // Seasons recorded before periods existed: ask for their dates (newest first, one item per field)
    const undated = own.find((s) => !s.sown_on);
    if (undated) {
      history.push({ kind: 'seasonDates', to: fieldPath(field.id, 'history'), field, year: undated.season_year });
    }
    if (missingDepth(field)) depth.push({ kind: 'wellDepth', to: fieldPath(field.id), field });
  }
  return [...todos, ...water, ...survey, ...history, ...depth];
}
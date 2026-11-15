import { supabase } from './supabase';
import { FieldError } from './fields';
import type { MessageKey } from '../i18n/en';

// Questions are asked at the level where they are true:
//   FARM_QUESTIONNAIRE   once per farmer (priorities, market, ownership, labour, machinery, risk)
//   FIELD_QUESTIONNAIRE  per field (what the farmer has seen on the land)
//   season details       per field and year, in crop_history (see seasons.ts)
//
// Texts live in en.ts / el.ts, so a missing translation fails the type check.
// PLACEHOLDER QUESTIONS: when a question is added, removed or changes meaning, bump that
// questionnaire's version. Old answers stay in the database under their own version.

// Special answer values
export const UNKNOWN = 'unknown'; // "I don't know" (different from "not answered yet")
export const NONE = 'none'; // "none of these years", "never"

export type AnswerValue = string | number | (string | number)[];
export type Answers = Record<string, AnswerValue>;

interface Base {
  id: string;
  titleKey: MessageKey;
  helpKey?: MessageKey;
  // Optional questions do not count towards progress
  optional?: boolean;
}

export interface Option {
  value: string;
  labelKey: MessageKey;
  descKey?: MessageKey;
}

export type Question =
  | (Base & { type: 'single'; options: Option[]; allowUnknown?: boolean })
  | (Base & { type: 'multi'; options: Option[]; max?: number })
  // Recent years, plus "none" and "I don't know"
  | (Base & { type: 'years'; span: number })
  // January-December, plus "I don't know"
  | (Base & { type: 'months' })
  // 1-5 scale with labels at both ends, plus "I don't know"
  | (Base & { type: 'scale'; lowKey: MessageKey; highKey: MessageKey })
  // A numeric slider. The stored answer is a number on the question's steps.
  | (Base & { type: 'range'; min: number; max: number; step: number })
  // A year typed by the farmer, plus "never" and "I don't know"
  | (Base & { type: 'year'; noneKey: MessageKey })
  | (Base & { type: 'text'; maxLength: number; placeholderKey?: MessageKey })
  // Crops from the database. The stored list is the crops the farmer will not grow,
  // or [NONE] when they would grow any of them.
  | (Base & { type: 'cropExclude' });

export interface Section {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  questions: Question[];
}

export interface QuestionnaireDef {
  version: string;
  sections: Section[];
}

export const opt = (value: string, labelKey: MessageKey, descKey?: MessageKey): Option => ({
  value,
  labelKey,
  descKey,
});

// Per field: the land itself
export const FIELD_QUESTIONNAIRE: QuestionnaireDef = {
  version: 'v2-draft',
  sections: [
    {
      id: 'water',
      titleKey: 'fieldQuestionnaire.sections.water.title',
      descKey: 'fieldQuestionnaire.sections.water.desc',
      questions: [
        {
          id: 'dryYears',
          type: 'years',
          span: 10,
          titleKey: 'fieldQuestionnaire.q.dryYears.title',
          helpKey: 'fieldQuestionnaire.q.dryYears.help',
        },
        {
          id: 'wetYears',
          type: 'years',
          span: 10,
          titleKey: 'fieldQuestionnaire.q.wetYears.title',
          helpKey: 'fieldQuestionnaire.q.wetYears.help',
        },
        {
          id: 'dryMonths',
          type: 'months',
          titleKey: 'fieldQuestionnaire.q.dryMonths.title',
          helpKey: 'fieldQuestionnaire.q.dryMonths.help',
        },
        {
          id: 'waterShortage',
          type: 'scale',
          titleKey: 'fieldQuestionnaire.q.waterShortage.title',
          helpKey: 'fieldQuestionnaire.q.waterShortage.help',
          lowKey: 'fieldQuestionnaire.q.waterShortage.low',
          highKey: 'fieldQuestionnaire.q.waterShortage.high',
        },
        {
          id: 'frost',
          type: 'single',
          allowUnknown: true,
          titleKey: 'fieldQuestionnaire.q.frost.title',
          helpKey: 'fieldQuestionnaire.q.frost.help',
          options: [
            opt('never', 'fieldQuestionnaire.q.frost.never'),
            opt('sometimes', 'fieldQuestionnaire.q.frost.sometimes'),
            opt('often', 'fieldQuestionnaire.q.frost.often'),
          ],
        },
      ],
    },
    {
      id: 'soil',
      titleKey: 'fieldQuestionnaire.sections.soil.title',
      descKey: 'fieldQuestionnaire.sections.soil.desc',
      questions: [
        {
          id: 'soilTexture',
          type: 'single',
          allowUnknown: true,
          titleKey: 'fieldQuestionnaire.q.soilTexture.title',
          options: [
            opt('sandy', 'fieldQuestionnaire.q.soilTexture.sandy', 'fieldQuestionnaire.q.soilTexture.sandyDesc'),
            opt('loam', 'fieldQuestionnaire.q.soilTexture.loam', 'fieldQuestionnaire.q.soilTexture.loamDesc'),
            opt('clay', 'fieldQuestionnaire.q.soilTexture.clay', 'fieldQuestionnaire.q.soilTexture.clayDesc'),
            opt('stony', 'fieldQuestionnaire.q.soilTexture.stony', 'fieldQuestionnaire.q.soilTexture.stonyDesc'),
          ],
        },
        {
          id: 'drainage',
          type: 'single',
          allowUnknown: true,
          titleKey: 'fieldQuestionnaire.q.drainage.title',
          options: [
            opt('hours', 'fieldQuestionnaire.q.drainage.hours'),
            opt('day', 'fieldQuestionnaire.q.drainage.day'),
            opt('days', 'fieldQuestionnaire.q.drainage.days'),
            opt('weeks', 'fieldQuestionnaire.q.drainage.weeks'),
          ],
        },
        {
          id: 'salinity',
          type: 'single',
          allowUnknown: true,
          titleKey: 'fieldQuestionnaire.q.salinity.title',
          helpKey: 'fieldQuestionnaire.q.salinity.help',
          options: [
            opt('no', 'fieldQuestionnaire.q.salinity.no'),
            opt('some', 'fieldQuestionnaire.q.salinity.some'),
            opt('often', 'fieldQuestionnaire.q.salinity.often'),
          ],
        },
        {
          id: 'lastSoilTest',
          type: 'year',
          titleKey: 'fieldQuestionnaire.q.lastSoilTest.title',
          helpKey: 'fieldQuestionnaire.q.lastSoilTest.help',
          noneKey: 'fieldQuestionnaire.q.lastSoilTest.never',
        },
        {
          id: 'maxMonths',
          type: 'range',
          min: 2,
          max: 12,
          step: 0.5,
          titleKey: 'fieldQuestionnaire.q.maxMonths.title',
          helpKey: 'fieldQuestionnaire.q.maxMonths.help',
        },
        {
          id: 'notes',
          type: 'text',
          optional: true,
          maxLength: 1000,
          titleKey: 'fieldQuestionnaire.q.notes.title',
          helpKey: 'fieldQuestionnaire.q.notes.help',
          placeholderKey: 'questionnaire.notesPlaceholder',
        },
      ],
    },
  ],
};

// Once per farmer: who they are and what they want
export const FARM_QUESTIONNAIRE: QuestionnaireDef = {
  version: 'v1-draft',
  sections: [
    {
      id: 'goals',
      titleKey: 'farmProfile.sections.goals.title',
      descKey: 'farmProfile.sections.goals.desc',
      questions: [
        {
          id: 'priorities',
          type: 'multi',
          max: 3,
          titleKey: 'farmProfile.q.priorities.title',
          helpKey: 'farmProfile.q.priorities.help',
          options: [
            opt('lessTools', 'farmProfile.q.priorities.lessTools'),
            opt('cutCosts', 'farmProfile.q.priorities.cutCosts'),
            opt('buildSoil', 'farmProfile.q.priorities.buildSoil'),
            opt('raiseIncome', 'farmProfile.q.priorities.raiseIncome'),
            opt('lowerRisk', 'farmProfile.q.priorities.lowerRisk'),
            opt('lessWork', 'farmProfile.q.priorities.lessWork'),
          ],
        },
        {
          id: 'riskAttitude',
          type: 'scale',
          titleKey: 'farmProfile.q.riskAttitude.title',
          helpKey: 'farmProfile.q.riskAttitude.help',
          lowKey: 'farmProfile.q.riskAttitude.low',
          highKey: 'farmProfile.q.riskAttitude.high',
        },
        {
          id: 'excludedCrops',
          type: 'cropExclude',
          titleKey: 'farmProfile.q.excludedCrops.title',
          helpKey: 'farmProfile.q.excludedCrops.help',
        },
      ],
    },
    {
      id: 'farm',
      titleKey: 'farmProfile.sections.farm.title',
      descKey: 'farmProfile.sections.farm.desc',
      questions: [
        {
          id: 'tenure',
          type: 'single',
          titleKey: 'farmProfile.q.tenure.title',
          helpKey: 'farmProfile.q.tenure.help',
          options: [
            opt('ownAll', 'farmProfile.q.tenure.ownAll'),
            opt('mostlyOwn', 'farmProfile.q.tenure.mostlyOwn'),
            opt('mostlyRent', 'farmProfile.q.tenure.mostlyRent'),
            opt('rentAll', 'farmProfile.q.tenure.rentAll'),
          ],
        },
        {
          id: 'labour',
          type: 'single',
          titleKey: 'farmProfile.q.labour.title',
          options: [
            opt('alone', 'farmProfile.q.labour.alone'),
            opt('family', 'farmProfile.q.labour.family'),
            opt('seasonal', 'farmProfile.q.labour.seasonal'),
            opt('permanent', 'farmProfile.q.labour.permanent'),
          ],
        },
        {
          id: 'machinery',
          type: 'single',
          titleKey: 'farmProfile.q.machinery.title',
          options: [
            opt('own', 'farmProfile.q.machinery.own', 'farmProfile.q.machinery.ownDesc'),
            opt('some', 'farmProfile.q.machinery.some', 'farmProfile.q.machinery.someDesc'),
            opt('hire', 'farmProfile.q.machinery.hire', 'farmProfile.q.machinery.hireDesc'),
          ],
        },
        {
          id: 'experience',
          type: 'single',
          titleKey: 'farmProfile.q.experience.title',
          options: [
            opt('lt5', 'farmProfile.q.experience.lt5'),
            opt('5to15', 'farmProfile.q.experience.5to15'),
            opt('15to30', 'farmProfile.q.experience.15to30'),
            opt('gt30', 'farmProfile.q.experience.gt30'),
          ],
        },
      ],
    },
  ],
};

// Helpers
export const allQuestions = (def: QuestionnaireDef): Question[] => def.sections.flatMap((s) => s.questions);
export const countedQuestions = (def: QuestionnaireDef): Question[] => allQuestions(def).filter((q) => !q.optional);

export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

// Completed means every current question has an answer and the farmer submitted that set.
// An older submitted response that lacks a question added later is not complete.
export function isFarmQuestionnaireComplete(response: QuestionnaireResponse | null): boolean {
  if (!response || response.status !== 'submitted') return false;
  return countAnswered(FARM_QUESTIONNAIRE, response.answers) === countedQuestions(FARM_QUESTIONNAIRE).length;
}

export function countAnswered(def: QuestionnaireDef, answers: Answers): number {
  return countedQuestions(def).filter((q) => isAnswered(answers[q.id])).length;
}

/**
 * The status that is actually stored: 'submitted' (shown as completed) only while every
 * counted question has an answer, 'draft' (in progress) otherwise. Clearing an answer of a
 * completed questionnaire makes it 'draft' again, and answering it makes it 'submitted'
 * again, so the screen never shows "completed" with questions missing.
 */
export function effectiveStatus(def: QuestionnaireDef, answers: Answers, wanted: ResponseStatus): ResponseStatus {
  return wanted === 'submitted' && countAnswered(def, answers) === countedQuestions(def).length ? 'submitted' : 'draft';
}

// Drops empty answers and anything not in this question set before saving
export function cleanAnswers(def: QuestionnaireDef, answers: Answers): Answers {
  const out: Answers = {};
  for (const q of allQuestions(def)) {
    const v = answers[q.id];
    if (!isAnswered(v)) continue;
    if (q.type === 'range') {
      if (typeof v !== 'number') continue;
      const steps = Math.round((v - q.min) / q.step);
      const snapped = Math.round((q.min + steps * q.step) * 1000) / 1000;
      if (snapped < q.min || snapped > q.max) continue;
      out[q.id] = snapped;
      continue;
    }
    out[q.id] = typeof v === 'string' ? v.trim().slice(0, q.type === 'text' ? q.maxLength : 64) : v;
  }
  return out;
}

// Database
export type ResponseStatus = 'draft' | 'submitted';

export interface QuestionnaireResponse {
  answers: Answers;
  status: ResponseStatus;
  updated_at: string;
  answered_count?: number;
  question_count?: number;
}

const COLUMNS = 'answers, status, updated_at, answered_count, question_count';

function rowFor(def: QuestionnaireDef, answers: Answers, status: ResponseStatus) {
  const clean = cleanAnswers(def, answers);
  return {
    version: def.version,
    answers: clean,
    status: effectiveStatus(def, clean, status),
    answered_count: countAnswered(def, clean),
    question_count: countedQuestions(def).length,
  };
}

const fail = (error: { code?: string | null; message: string }) => new FieldError(error.code ?? null, error.message);

// Field questionnaire answers of one field (current version), or null when not started
export async function loadFieldResponse(fieldId: string): Promise<QuestionnaireResponse | null> {
  const { data, error } = await supabase
    .from('questionnaire_responses')
    .select(COLUMNS)
    .eq('field_id', fieldId)
    .eq('version', FIELD_QUESTIONNAIRE.version)
    .maybeSingle();
  if (error) throw fail(error);
  return (data as QuestionnaireResponse | null) ?? null;
}

export async function saveFieldResponse(
  fieldId: string,
  answers: Answers,
  status: ResponseStatus,
): Promise<QuestionnaireResponse> {
  const { data, error } = await supabase
    .from('questionnaire_responses')
    .upsert({ field_id: fieldId, ...rowFor(FIELD_QUESTIONNAIRE, answers, status) }, { onConflict: 'field_id,version' })
    .select(COLUMNS)
    .single();
  if (error) throw fail(error);
  return data as QuestionnaireResponse;
}

// The farmer's own profile answers (current version), or null when not started
export async function loadFarmResponse(): Promise<QuestionnaireResponse | null> {
  const { data, error } = await supabase
    .from('farmer_questionnaire_responses')
    .select(COLUMNS)
    .eq('version', FARM_QUESTIONNAIRE.version)
    .maybeSingle();
  if (error) throw fail(error);
  return (data as QuestionnaireResponse | null) ?? null;
}

export async function saveFarmResponse(answers: Answers, status: ResponseStatus): Promise<QuestionnaireResponse> {
  const { data, error } = await supabase
    .from('farmer_questionnaire_responses')
    .upsert(rowFor(FARM_QUESTIONNAIRE, answers, status), { onConflict: 'user_id,version' })
    .select(COLUMNS)
    .single();
  if (error) throw fail(error);
  return data as QuestionnaireResponse;
}

export interface CopySource {
  id: string;
  name: string;
  answered: number;
}

// The farmer's other fields that already have field-questionnaire answers, to copy from
export async function listCopySources(excludeFieldId: string): Promise<CopySource[]> {
  const { data, error } = await supabase
    .from('my_fields')
    .select('id, name, survey_version, survey_answered')
    .neq('id', excludeFieldId)
    .eq('survey_version', FIELD_QUESTIONNAIRE.version)
    .gt('survey_answered', 0)
    .order('name');
  if (error) throw fail(error);
  return ((data ?? []) as { id: string; name: string; survey_answered: number }[]).map((r) => ({
    id: r.id,
    name: r.name,
    answered: r.survey_answered,
  }));
}
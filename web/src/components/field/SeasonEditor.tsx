import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Droplets,
  FlaskConical,
  HandCoins,
  Loader2,
  SprayCan,
  Sprout,
  Tractor,
  Wand2,
  Wheat,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import { describeError, FieldError } from '../../lib/fields';
import { setUnsavedMessage } from '../../lib/navigationGuard';
import { isAnswered, type AnswerValue } from '../../lib/questionnaire';
import {
  MAX_SEASON_DAYS,
  NOTES_MAX,
  SEASON_DETAILS,
  cropName,
  daysBetween,
  findOverlap,
  listApplications,
  listIncome,
  listProtections,
  listSeeds,
  monthsBetween,
  saveSeason,
  seasonCostPerStremma,
  seedCropsOf,
  suggestPeriod,
  todayIso,
  type Crop,
  type FertilizerApplication,
  type FertilizerProduct,
  type ProtectionApplication,
  type ProtectionProduct,
  type Season,
  type SeasonIncome,
  type SeasonInput,
  type SeedApplication,
  type SeedVariety,
  type YieldFactors,
} from '../../lib/seasons';
import { QuestionInput } from '../questionnaire/QuestionInputs';
import { secondaryBtn } from '../questionnaire/QuestionnaireWizard';
import { SeasonTimeline } from './SeasonTimeline';
import { FertilizerSection, draftFromApplication, draftToInput, validateFert, type FertDraft } from './FertilizerSection';
import { ProtectionSection, draftFromProtection, protToInput, validateProt, type ProtDraft } from './ProtectionSection';
import { SeedSection, draftFromSeed, seedToInput, validateSeed, type SeedDraft } from './SeedSection';
import {
  IrrigationSection,
  irrigationDraftFrom,
  irrigationToInput,
  validateIrrigation,
  type IrrigationDraft,
} from './IrrigationSection';
import {
  irrigationCost,
  listIrrigation,
  type IrrigationBaseline,
  type IrrigationField,
  type IrrigationParams,
  type SeasonIrrigationRecord,
} from '../../lib/irrigation';
import {
  IncomeSection,
  incomeDraftEmpty,
  incomeDraftFrom,
  incomeToInput,
  validateIncome,
  type IncomeDraft,
} from './IncomeSection';
import { fullDate, monthName, periodLabel } from './periodLabel';

// One season, in seven steps like the questionnaires: crop and period, how it was grown, seed,
// fertilisers, plant protection, irrigation, income. Nothing is saved until "Save season"; then the
// season and everything in it are saved together, so a half-filled season never ends up in the
// database

type StepId = 'crop' | 'practices' | 'seed' | 'fertilizers' | 'protection' | 'irrigation' | 'income';
const STEPS: { id: StepId; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'crop', icon: CalendarRange },
  { id: 'practices', icon: Tractor },
  { id: 'seed', icon: Wheat },
  { id: 'fertilizers', icon: FlaskConical },
  { id: 'protection', icon: SprayCan },
  { id: 'irrigation', icon: Droplets },
  { id: 'income', icon: HandCoins },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i])) as Record<StepId, number>;

type Details = Pick<SeasonInput, 'tillage' | 'residues' | 'nitrogen' | 'irrigation' | 'yield_outcome' | 'notes'>;

interface Props {
  fieldId: string;
  areaHa: number | null;
  // The season to edit, or null for a new one
  season: Season | null;
  // All seasons of the field (for overlaps and the calendar)
  seasons: Season[];
  crops: Crop[];
  products: FertilizerProduct[];
  applications: FertilizerApplication[];
  protectionProducts: ProtectionProduct[];
  protections: ProtectionApplication[];
  // The season's stored income, if any
  income: SeasonIncome | null;
  seedVarieties: SeedVariety[];
  seeds: SeedApplication[];
  // The season's stored irrigation, if any
  irrigation: SeasonIrrigationRecord | null;
  irrigationParams: IrrigationParams;
  irrigationBaselines: Map<string, IrrigationBaseline>;
  // The field, as the irrigation calculation needs it
  field: IrrigationField;
  yieldFactors: YieldFactors;
  onSaved: (
    season: Season,
    applications: FertilizerApplication[],
    protections: ProtectionApplication[],
    income: SeasonIncome | null,
    seeds: SeedApplication[],
    irrigation: SeasonIrrigationRecord | null,
  ) => void;
  onClose: () => void;
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors aria-[invalid=true]:border-red-400/60';

export const SeasonEditor: React.FC<Props> = ({
  fieldId,
  areaHa,
  season,
  seasons,
  crops,
  products,
  applications,
  protectionProducts,
  protections,
  income,
  yieldFactors,
  seedVarieties,
  seeds,
  irrigation,
  irrigationParams,
  irrigationBaselines,
  field,
  onSaved,
  onClose,
}) => {
  const { t, language, locale } = useLanguage();
  const topRef = useRef<HTMLDivElement>(null);
  const today = todayIso();
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const protProductById = useMemo(() => new Map(protectionProducts.map((p) => [p.id, p])), [protectionProducts]);

  const [step, setStep] = useState(0);
  const [cropId, setCropId] = useState(season?.crop_id ?? '');
  const [sown, setSown] = useState(season?.sown_on ?? '');
  const [harvested, setHarvested] = useState(season?.harvested_on ?? '');
  const [ongoing, setOngoing] = useState(Boolean(season?.sown_on && !season.harvested_on));
  const [details, setDetails] = useState<Details>({
    tillage: season?.tillage ?? null,
    residues: season?.residues ?? null,
    nitrogen: season?.nitrogen ?? null,
    irrigation: season?.irrigation ?? null,
    yield_outcome: season?.yield_outcome ?? null,
    notes: season?.notes ?? null,
  });
  const [ferts, setFerts] = useState<FertDraft[]>(() => applications.map(draftFromApplication));
  const [prots, setProts] = useState<ProtDraft[]>(() => protections.map(draftFromProtection));
  const [incomeDraft, setIncomeDraft] = useState<IncomeDraft>(() => incomeDraftFrom(income));
  const [seedDrafts, setSeedDrafts] = useState<SeedDraft[]>(() => seeds.map(draftFromSeed));
  const [irrigationDraft, setIrrigationDraft] = useState<IrrigationDraft>(() => irrigationDraftFrom(irrigation));
  const varietyById = useMemo(() => new Map(seedVarieties.map((v) => [v.id, v])), [seedVarieties]);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const touch = () => {
    setDirty(true);
    setSaveError(null);
  };

  // Warn before leaving with unsaved changes (tab close, header links, tabs, back button)
  useEffect(() => {
    if (!dirty) {
      setUnsavedMessage(null);
      return;
    }
    const msg = t('questionnaire.unsavedLeave');
    setUnsavedMessage(msg);
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = msg;
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      setUnsavedMessage(null);
    };
  }, [dirty, t]);

  const sortedCrops = useMemo(() => {
    const named = crops.map((c) => ({ crop: c, name: cropName(c, language, c.id) }));
    return named.sort((a, b) =>
      a.crop.id === 'other' ? 1 : b.crop.id === 'other' ? -1 : a.name.localeCompare(b.name, locale),
    );
  }, [crops, language, locale]);

  const crop = cropById.get(cropId);
  const end = ongoing ? null : harvested || null;
  const others = seasons.filter((s) => s.id !== season?.id);

  // Crop and period: validation (same rules as the database, with clear messages)
  const cropProblem = useMemo((): { key: MessageKey; vars?: Record<string, string> } | null => {
    if (!cropId) return { key: 'seasons.invalid.crop' };
    if (!sown) return { key: 'seasons.invalid.sown' };
    if (!ongoing && !harvested) return { key: 'seasons.invalid.harvested' };
    if (sown > today || (!ongoing && harvested > today)) return { key: 'seasons.invalid.future' };
    if (!ongoing && harvested <= sown) return { key: 'seasons.invalid.order' };
    if (!ongoing && daysBetween(sown, harvested) > MAX_SEASON_DAYS) return { key: 'seasons.invalid.tooLong' };
    const hit = findOverlap(sown, end, others);
    if (hit) {
      const name = cropName(cropById.get(hit.crop_id), language, t('seasons.unknownCrop'));
      return hit.harvested_on
        ? { key: 'seasons.invalid.overlap', vars: { crop: name, period: periodLabel(t, locale, hit) } }
        : { key: 'seasons.invalid.overlapOpen', vars: { crop: name, date: fullDate(hit.sown_on!, locale) } };
    }
    return null;
  }, [cropId, sown, harvested, ongoing, end, today, others, cropById, language, locale, t]);

  const fertProblems = ferts.some((f) => Object.keys(validateFert(f)).length > 0);
  const protProblems = prots.some((p) => Object.keys(validateProt(p)).length > 0);
  const incomeProblems = !ongoing && Object.keys(validateIncome(incomeDraft)).length > 0;
  const seedProblems = Boolean(cropId) && seedDrafts.some((d) => Object.keys(validateSeed(d, cropId)).length > 0);
  const irrigationProblems = Object.keys(validateIrrigation(irrigationDraft)).length > 0;

  // The season as the irrigation calculation sees it (period and the "Irrigation" answer of step 2)
  const irrigationSeason = useMemo(
    () => ({ crop_id: cropId, sown_on: sown || null, harvested_on: end, irrigation: details.irrigation }),
    [cropId, sown, end, details.irrigation],
  );
  const irrigationResult = useMemo(
    () =>
      cropId ? irrigationCost(irrigationSeason, irrigationToInput(irrigationDraft), field, irrigationParams, irrigationBaselines) : null,
    [cropId, irrigationSeason, irrigationDraft, field, irrigationParams, irrigationBaselines],
  );

  // Costs recorded in the Fertilisers and Plant protection steps, per stremma (for the Income step)
  const costs = useMemo(
    () =>
      seasonCostPerStremma(
        ferts.map((f) => draftToInput(f, productById)),
        prots.map((p) => protToInput(p, protProductById)),
        cropId ? seedDrafts.map((d) => seedToInput(d, varietyById, cropId)) : [],
        irrigationResult,
      ),
    [ferts, prots, seedDrafts, cropId, productById, protProductById, varietyById, irrigationResult],
  );

  const chooseCrop = (id: string) => {
    setCropId(id);
    touch();
    // Seed already filled in: keep what still fits the new crop
    const parts = seedCropsOf(id);
    setSeedDrafts((list) =>
      list.map((d) => {
        const variety = d.variety_id ? varietyById.get(d.variety_id) : undefined;
        const part = parts.length > 1 ? (d.crop_id && parts.includes(d.crop_id) ? d.crop_id : null) : id;
        return variety && variety.crop_id !== part ? { ...d, crop_id: part, variety_id: null } : { ...d, crop_id: part };
      }),
    );
    // A new season with no dates yet: suggest the usual ones for this crop
    if (!sown && !harvested && !ongoing) {
      const s = suggestPeriod(cropById.get(id), others, season?.id, today);
      if (s) {
        setSown(s.sown_on);
        setHarvested(s.harvested_on);
      }
    }
  };

  const applyTypical = () => {
    const s = suggestPeriod(crop, others, season?.id, today);
    if (!s) return;
    setSown(s.sown_on);
    setHarvested(s.harvested_on);
    setOngoing(false);
    touch();
  };

  // Calendar preview: the years this season touches
  const previewYears = useMemo(() => {
    if (!sown) return [Number(today.slice(0, 4))];
    const from = Number(sown.slice(0, 4));
    const to = Number((end ?? today).slice(0, 4));
    const list: number[] = [];
    for (let y = from; y <= Math.max(from, to) && list.length < 4; y++) list.push(y);
    return list;
  }, [sown, end, today]);

  // Steps
  const practiceDetails = SEASON_DETAILS.filter((d) => !(ongoing && d.id === 'yield_outcome'));
  const practicesAnswered = practiceDetails.filter((d) => isAnswered((details[d.id as keyof Details] as AnswerValue | null) ?? undefined)).length;

  const goTo = (i: number) => {
    setStep(i);
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const save = async () => {
    if (saving) return;
    if (cropProblem || seedProblems || fertProblems || protProblems || irrigationProblems || incomeProblems) {
      setShowErrors(true);
      goTo(
        STEP_INDEX[
          cropProblem
            ? 'crop'
            : seedProblems
              ? 'seed'
              : fertProblems
                ? 'fertilizers'
                : protProblems
                  ? 'protection'
                  : irrigationProblems
                    ? 'irrigation'
                    : 'income'
        ],
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const input: SeasonInput = {
        crop_id: cropId,
        sown_on: sown,
        harvested_on: end,
        ...details,
        yield_outcome: ongoing ? null : details.yield_outcome,
      };
      const saved = await saveSeason(
        fieldId,
        input,
        ferts.map((f) => draftToInput(f, productById)),
        prots.map((p) => protToInput(p, protProductById)),
        // Nothing stored and nothing filled in: leave it out rather than store an empty row
        !income && incomeDraftEmpty(incomeDraft) ? null : incomeToInput(incomeDraft),
        seedDrafts.map((d) => seedToInput(d, varietyById, cropId)),
        // Nothing chosen: no record, the database estimates from the field's defaults
        irrigationToInput(irrigationDraft),
        season?.id,
      );
      const [apps, treatments, incomes, savedSeeds, irrigations] = await Promise.all([
        listApplications([saved.id]),
        listProtections([saved.id]),
        listIncome([saved.id]),
        listSeeds([saved.id]),
        listIrrigation([saved.id]),
      ]);
      setDirty(false);
      setUnsavedMessage(null);
      onSaved(saved, apps, treatments, incomes[0] ?? null, savedSeeds, irrigations[0] ?? null);
    } catch (err) {
      setSaveError(
        err instanceof FieldError && err.code === '23P01' ? t('seasons.overlapServer') : describeError(err, t),
      );
    } finally {
      setSaving(false);
    }
  };

  const stepState = (id: StepId): { text: string; tone: 'ok' | 'warn' | 'plain' } => {
    if (id === 'crop') {
      return cropProblem
        ? { text: showErrors ? '!' : '', tone: showErrors ? 'warn' : 'plain' }
        : { text: '✓', tone: 'ok' };
    }
    if (id === 'practices') return { text: `${practicesAnswered}/${practiceDetails.length}`, tone: 'plain' };
    if (id === 'irrigation') {
      if (showErrors && irrigationProblems) return { text: '!', tone: 'warn' };
      return irrigationDraft.source !== null ? { text: '✓', tone: 'ok' } : { text: '', tone: 'plain' };
    }
    if (id === 'income') {
      if (showErrors && incomeProblems) return { text: '!', tone: 'warn' };
      return !ongoing && !incomeDraftEmpty(incomeDraft) ? { text: '✓', tone: 'ok' } : { text: '', tone: 'plain' };
    }
    const [count, problems] =
      id === 'seed' ? [seedDrafts.length, seedProblems] : id === 'fertilizers' ? [ferts.length, fertProblems] : [prots.length, protProblems];
    return { text: showErrors && problems ? '!' : String(count), tone: showErrors && problems ? 'warn' : 'plain' };
  };

  const current = STEPS[step];
  const title = season ? t('seasons.editTitle', { year: periodLabel(t, locale, season) }) : t('seasons.addTitle');

  return (
    <div ref={topRef} className="space-y-5 scroll-mt-24">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-cf-muted hover:text-cf-text inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('seasons.back')}
          </button>
          <h2 className="text-xl sm:text-2xl font-semibold text-cf-text">{title}</h2>
        </div>
        {crop && (
          <span className="self-start sm:self-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cf-panel border border-cf-border text-sm text-cf-muted">
            <Sprout className="w-3.5 h-3.5 text-cf-primary" />
            <span className="font-medium text-cf-text">{cropName(crop, language, crop.id)}</span>
            {sown && <span className="text-cf-muted">· {periodLabel(t, locale, { sown_on: sown, harvested_on: end, season_year: 0 })}</span>}
          </span>
        )}
      </div>

      {/* Steps on phones */}
      <nav className="lg:hidden fs-chip-row flex gap-2 overflow-x-auto -mx-1 px-1 pb-1" aria-label={title}>
        {STEPS.map((s, i) => (
          <StepButton key={s.id} id={s.id} icon={s.icon} index={i} active={i === step} state={stepState(s.id)} compact onClick={() => goTo(i)} />
        ))}
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[230px_minmax(0,1fr)] gap-6 items-start">
        <nav className="hidden lg:block lg:sticky lg:top-24 space-y-1.5" aria-label={title}>
          {STEPS.map((s, i) => (
            <StepButton key={s.id} id={s.id} icon={s.icon} index={i} active={i === step} state={stepState(s.id)} onClick={() => goTo(i)} />
          ))}
        </nav>

        <section className="cf-glass-box rounded-2xl overflow-hidden" aria-labelledby="fs-season-step-title">
          <header className="px-5 sm:px-7 pt-6 pb-5 border-b border-cf-border">
            <p className="text-xs font-medium text-cf-primary tabular-nums">
              {t('questionnaire.stepOf', { n: String(step + 1), total: String(STEPS.length) })}
            </p>
            <h3 id="fs-season-step-title" className="text-xl font-semibold text-cf-text mt-1">
              {t(`seasons.sections.${current.id}.title`)}
            </h3>
            <p className="text-sm text-cf-muted mt-1">{t(`seasons.sections.${current.id}.desc`)}</p>
          </header>

          <div className="px-5 sm:px-7 py-6 space-y-6">
            {current.id === 'crop' && (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="fs-season-crop" className="text-sm font-medium text-cf-muted">
                    {t('seasons.crop')}
                  </label>
                  <select
                    id="fs-season-crop"
                    value={cropId}
                    onChange={(e) => chooseCrop(e.target.value)}
                    aria-invalid={showErrors && !cropId ? true : undefined}
                    className={`${inputCls} cursor-pointer`}
                  >
                    <option value="" disabled>
                      {t('seasons.cropPlaceholder')}
                    </option>
                    {sortedCrops.map(({ crop: c, name }) => (
                      <option key={c.id} value={c.id}>
                        {name}
                      </option>
                    ))}
                  </select>
                  {crop &&
                    (crop.sowing_month && crop.harvest_month ? (
                      <p className="text-sm text-cf-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>
                          {t('seasons.typical', {
                            sow: monthName(crop.sowing_month, locale),
                            harvest: monthName(crop.harvest_month, locale),
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={applyTypical}
                          className="inline-flex items-center gap-1 text-cf-primary hover:underline cursor-pointer"
                        >
                          <Wand2 className="w-3.5 h-3.5" />
                          {t('seasons.useTypical')}
                        </button>
                      </p>
                    ) : (
                      <p className="text-sm text-cf-muted">{t('seasons.noTypical')}</p>
                    ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="fs-season-sown" className="text-sm font-medium text-cf-muted">
                      {t('seasons.sown')}
                    </label>
                    <input
                      id="fs-season-sown"
                      type="date"
                      value={sown}
                      max={today}
                      onChange={(e) => {
                        setSown(e.target.value);
                        touch();
                      }}
                      aria-invalid={showErrors && !sown ? true : undefined}
                      className={`${inputCls} [color-scheme:light] tabular-nums`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="fs-season-harvested" className="text-sm font-medium text-cf-muted">
                      {t('seasons.harvested')}
                    </label>
                    <input
                      id="fs-season-harvested"
                      type="date"
                      value={ongoing ? '' : harvested}
                      min={sown || undefined}
                      max={today}
                      disabled={ongoing}
                      onChange={(e) => {
                        setHarvested(e.target.value);
                        touch();
                      }}
                      aria-invalid={showErrors && !ongoing && !harvested ? true : undefined}
                      className={`${inputCls} [color-scheme:light] tabular-nums disabled:opacity-50`}
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2.5 text-sm text-cf-muted cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={ongoing}
                    onChange={(e) => {
                      setOngoing(e.target.checked);
                      touch();
                    }}
                    className="w-4 h-4 accent-[var(--color-sage)] cursor-pointer"
                  />
                  {t('seasons.ongoing')}
                </label>

                {sown && !cropProblem && (
                  <p className="text-sm text-cf-primary flex items-center gap-2">
                    <Check className="w-4 h-4" />
                    {periodLabel(t, locale, { sown_on: sown, harvested_on: end, season_year: 0 })}
                    {end && <span className="text-cf-muted">· {t('seasons.period.months', { count: String(monthsBetween(sown, end)) })}</span>}
                  </p>
                )}
                {cropProblem && (showErrors || (sown && (harvested || ongoing))) && (
                  <p className="text-sm text-red-800 flex items-start gap-2" role="alert">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    {t(cropProblem.key, cropProblem.vars)}
                  </p>
                )}

                <div className="space-y-2 pt-1">
                  <p className="text-sm font-medium text-cf-muted">{t('seasons.preview')}</p>
                  <SeasonTimeline
                    seasons={others}
                    crops={cropById}
                    focusYears={previewYears}
                    draft={sown ? { start: sown, end, cropId: cropId || 'other', conflict: Boolean(cropProblem && sown) } : null}
                  />
                </div>
              </>
            )}

            {current.id === 'practices' && (
              <>
                {practiceDetails.map((detail) => (
                  <div key={detail.id} className="space-y-2.5">
                    <div>
                      <p id={`${detail.id}-title`} className="text-[0.95rem] font-medium text-cf-text">
                        {t(detail.titleKey)}
                      </p>
                      {detail.helpKey && <p className="text-sm text-cf-muted">{t(detail.helpKey)}</p>}
                    </div>
                    <QuestionInput
                      question={detail}
                      value={(details[detail.id as keyof Details] as AnswerValue | null) ?? undefined}
                      onChange={(v) => {
                        setDetails((d) => ({ ...d, [detail.id]: (v as string | undefined) ?? null }));
                        touch();
                      }}
                    />
                  </div>
                ))}
                <div className="space-y-1.5">
                  <label htmlFor="fs-season-notes" className="text-[0.95rem] font-medium text-cf-text">
                    {t('seasons.notes')}
                    <span className="ml-2 align-middle px-2 py-0.5 rounded-full bg-cf-panel border border-cf-border text-[0.7rem] font-normal text-cf-muted">
                      {t('questionnaire.optional')}
                    </span>
                  </label>
                  <p className="text-sm text-cf-muted">{t('seasons.notesHelp')}</p>
                  <textarea
                    id="fs-season-notes"
                    value={details.notes ?? ''}
                    maxLength={NOTES_MAX}
                    rows={3}
                    onChange={(e) => {
                      setDetails((d) => ({ ...d, notes: e.target.value || null }));
                      touch();
                    }}
                    placeholder={t('questionnaire.notesPlaceholder')}
                    className={`${inputCls} resize-y`}
                  />
                </div>
              </>
            )}

            {current.id === 'seed' && (
              <SeedSection
                drafts={seedDrafts}
                onChange={(next) => {
                  setSeedDrafts(next);
                  touch();
                }}
                crop={crop}
                crops={cropById}
                varieties={seedVarieties}
                seasonSown={sown || null}
                areaHa={areaHa}
                showErrors={showErrors}
              />
            )}

            {current.id === 'fertilizers' && (
              <FertilizerSection
                drafts={ferts}
                onChange={(next) => {
                  setFerts(next);
                  touch();
                }}
                products={products}
                period={sown ? { start: sown, end, label: periodLabel(t, locale, { sown_on: sown, harvested_on: end, season_year: 0 }) } : null}
                areaHa={areaHa}
                showErrors={showErrors}
              />
            )}

            {current.id === 'protection' && (
              <ProtectionSection
                drafts={prots}
                onChange={(next) => {
                  setProts(next);
                  touch();
                }}
                products={protectionProducts}
                period={sown ? { start: sown, end, label: periodLabel(t, locale, { sown_on: sown, harvested_on: end, season_year: 0 }) } : null}
                areaHa={areaHa}
                showErrors={showErrors}
              />
            )}

            {current.id === 'irrigation' && (
              <IrrigationSection
                draft={irrigationDraft}
                onChange={(next) => {
                  setIrrigationDraft(next);
                  touch();
                }}
                season={irrigationSeason}
                cropLabel={crop ? cropName(crop, language, crop.id) : ''}
                field={field}
                params={irrigationParams}
                baselines={irrigationBaselines}
                showErrors={showErrors}
              />
            )}

            {current.id === 'income' && (
              <IncomeSection
                draft={incomeDraft}
                onChange={(next) => {
                  setIncomeDraft(next);
                  touch();
                }}
                crop={crop}
                cropLabel={crop ? cropName(crop, language, crop.id) : ''}
                season={{ sown_on: sown || null, harvested_on: end, yield_outcome: ongoing ? null : details.yield_outcome }}
                factors={yieldFactors}
                costs={costs}
                areaHa={areaHa}
                showErrors={showErrors}
              />
            )}

            {showErrors && (cropProblem || seedProblems || fertProblems || protProblems || irrigationProblems || incomeProblems) && (
              <p className="text-sm text-cf-primary">{t('seasons.invalid.fix')}</p>
            )}
            {saveError && (
              <p className="text-sm text-red-800" role="alert">
                {saveError}
              </p>
            )}
          </div>

          <footer className="px-5 sm:px-7 py-4 border-t border-cf-border bg-cf-panel/40 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <button type="button" onClick={() => goTo(step - 1)} disabled={step === 0} className={`${secondaryBtn} disabled:invisible`}>
              <ChevronLeft className="w-4 h-4" />
              {t('questionnaire.back')}
            </button>
            <div className="flex flex-col-reverse sm:flex-row gap-2.5">
              {step < STEPS.length - 1 && (
                <button type="button" onClick={() => goTo(step + 1)} className={secondaryBtn}>
                  {t('questionnaire.next')}
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="cf-btn-primary px-5 py-2.5 rounded-lg text-sm flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {saving ? t('seasons.saving') : t('seasons.save')}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
};

const StepButton: React.FC<{
  id: StepId;
  icon: React.ComponentType<{ className?: string }>;
  index: number;
  active: boolean;
  state: { text: string; tone: 'ok' | 'warn' | 'plain' };
  compact?: boolean;
  onClick: () => void;
}> = ({ id, icon: Icon, index, active, state, compact, onClick }) => {
  const { t } = useLanguage();
  const badge = {
    ok: 'bg-cf-hero/15 text-cf-primary border-cf-primary/40',
    warn: 'bg-red-50 text-red-900 border-red-700/30',
    plain: 'bg-cf-panel text-cf-muted border-cf-border',
  }[state.tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'step' : undefined}
      className={`${compact ? 'shrink-0 px-3 py-2' : 'w-full px-3 py-2.5'} text-left rounded-xl cursor-pointer flex items-center gap-3 ${
        active
          ? 'cf-glass-sage text-cf-text'
          : 'border border-transparent text-cf-muted hover:text-cf-text hover:bg-cf-panel transition-colors'
      }`}
    >
      <span className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${active ? 'bg-cf-hero text-cf-primary' : 'bg-cf-bg text-cf-muted'}`}>
        <Icon className="w-4 h-4" />
      </span>
      <span className={`text-sm font-medium ${active ? 'text-cf-text' : 'text-cf-muted'} ${compact ? 'whitespace-nowrap' : 'flex-1'}`}>
        {index + 1}. {t(`seasons.sections.${id}.title`)}
      </span>
      {state.text && (
        <span className={`px-1.5 py-0.5 rounded-full border text-[0.7rem] font-medium tabular-nums ${badge}`}>{state.text}</span>
      )}
    </button>
  );
};
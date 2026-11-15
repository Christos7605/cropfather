import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarClock,
  Droplets,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  ReceiptEuro,
  ShieldCheck,
  SprayCan,
  Sprout,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wheat,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { describeError } from '../../lib/fields';
import { confirmLeave } from '../../lib/navigationGuard';
import { UNKNOWN } from '../../lib/questionnaire';
import {
  SEASON_DETAILS,
  cropName,
  deleteSeason,
  listApplications,
  listCrops,
  DEFAULT_YIELD_FACTORS,
  STREMMA_PER_HA,
  perStremmaEur,
  listFertilizerProducts,
  listIncome,
  listProtectionProducts,
  listProtections,
  listSeasons,
  listSeedVarieties,
  listSeeds,
  listYieldFactors,
  monthsBetween,
  nutrientKgPerStremma,
  seasonCostPerStremma,
  seasonRevenue,
  sortSeasons,
  type Crop,
  type FertilizerApplication,
  type FertilizerProduct,
  type ProtectionApplication,
  type ProtectionProduct,
  type Season,
  type SeasonIncome,
  type SeedApplication,
  type SeedVariety,
  type YieldFactors,
} from '../../lib/seasons';
import {
  DEFAULT_IRRIGATION_PARAMS,
  irrigationCost,
  listIrrigation,
  listIrrigationBaselines,
  listIrrigationParams,
  type IrrigationBaseline,
  type IrrigationField,
  type IrrigationParams,
  type SeasonIrrigationRecord,
} from '../../lib/irrigation';
import { ErrorBox } from '../questionnaire/QuestionnaireWizard';
import { SeasonEditor } from './SeasonEditor';
import { SeasonTimeline, cropColor } from './SeasonTimeline';
import { periodLabel } from './periodLabel';

// Crop history of one field: a tab of the field page (/fields/:id?tab=history)
// The list shows the field calendar and every season; ?season=new or ?season=<id> opens the
// season editor (crop and period, how it was grown, seed, fertilisers, plant protection, irrigation,
// income)

const YIELD_DETAIL = SEASON_DETAILS.find((d) => d.id === 'yield_outcome')!;
const PRACTICE_DETAILS = SEASON_DETAILS.filter((d) => d.id !== 'yield_outcome');

const YIELD_TONE: Record<string, string> = {
  failed: 'bg-red-50 border-red-700/30 text-red-900',
  poor: 'bg-red-50/15 border-red-800/40 text-red-800',
  normal: 'bg-cf-panel border-cf-border text-cf-muted',
  good: 'bg-cf-hero/15 border-cf-primary/50 text-cf-primary',
  unknown: 'bg-cf-panel border-cf-border text-cf-muted',
};

const NO_FIELD: IrrigationField = { area_ha: null, water_point_id: null, irrigation: 'rainfed', well_depth_m: null, pump_depth_m: null };

export const SeasonsTab: React.FC<{
  fieldId: string;
  areaHa?: number | null;
  // The field, as the irrigation calculation needs it (water source, depths, supply)
  field?: IrrigationField;
  onChange?: (seasons: Season[]) => void;
}> = ({ fieldId, areaHa = null, field: fieldInfo, onChange }) => {
  const field = fieldInfo ?? { ...NO_FIELD, area_ha: areaHa };
  const { t, language, locale } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [params, setParams] = useSearchParams();

  const [crops, setCrops] = useState<Crop[]>([]);
  const [products, setProducts] = useState<FertilizerProduct[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [apps, setApps] = useState<FertilizerApplication[]>([]);
  const [protProducts, setProtProducts] = useState<ProtectionProduct[]>([]);
  const [prots, setProts] = useState<ProtectionApplication[]>([]);
  const [incomes, setIncomes] = useState<SeasonIncome[]>([]);
  const [factors, setFactors] = useState<YieldFactors>(DEFAULT_YIELD_FACTORS);
  const [varieties, setVarieties] = useState<SeedVariety[]>([]);
  const [seeds, setSeeds] = useState<SeedApplication[]>([]);
  const [irrigations, setIrrigations] = useState<SeasonIrrigationRecord[]>([]);
  const [irrParams, setIrrParams] = useState<IrrigationParams>(DEFAULT_IRRIGATION_PARAMS);
  const [irrBaselines, setIrrBaselines] = useState<Map<string, IrrigationBaseline>>(new Map());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [cropList, seasonList, productList, protProductList, factorList, varietyList, paramList, baselineMap] =
        await Promise.all([
          listCrops(),
          listSeasons(fieldId),
          listFertilizerProducts(),
          listProtectionProducts(),
          listYieldFactors(),
          listSeedVarieties(),
          listIrrigationParams(),
          listIrrigationBaselines(),
        ]);
      const ids = seasonList.map((s) => s.id);
      const [appList, protList, incomeList, seedList, irrigationList] = await Promise.all([
        listApplications(ids),
        listProtections(ids),
        listIncome(ids),
        listSeeds(ids),
        listIrrigation(ids),
      ]);
      setCrops(cropList);
      setSeasons(seasonList);
      setProducts(productList);
      setApps(appList);
      setProtProducts(protProductList);
      setProts(protList);
      setIncomes(incomeList);
      setFactors(factorList);
      setVarieties(varietyList);
      setSeeds(seedList);
      setIrrigations(irrigationList);
      setIrrParams(paramList);
      setIrrBaselines(baselineMap);
      setState('ready');
    } catch (err) {
      setLoadError(describeError(err, tRef.current));
      setState('error');
    }
  }, [fieldId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every change is reported to the field page (season count in its header and cards)
  useEffect(() => {
    if (state === 'ready') onChangeRef.current?.(seasons);
  }, [seasons, state]);

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops]);
  const appsBySeason = useMemo(() => {
    const map = new Map<number, FertilizerApplication[]>();
    for (const a of apps) map.set(a.season_id, [...(map.get(a.season_id) ?? []), a]);
    return map;
  }, [apps]);
  const incomeBySeason = useMemo(() => new Map(incomes.map((i) => [i.season_id, i])), [incomes]);
  const irrigationBySeason = useMemo(() => new Map(irrigations.map((r) => [r.season_id, r])), [irrigations]);
  const seedsBySeason = useMemo(() => {
    const map = new Map<number, SeedApplication[]>();
    for (const sd of seeds) map.set(sd.season_id, [...(map.get(sd.season_id) ?? []), sd]);
    return map;
  }, [seeds]);
  const protsBySeason = useMemo(() => {
    const map = new Map<number, ProtectionApplication[]>();
    for (const p of prots) map.set(p.season_id, [...(map.get(p.season_id) ?? []), p]);
    return map;
  }, [prots]);

  // ?season=new | <id> opens the editor
  const seasonParam = params.get('season');
  const editing: Season | null | undefined =
    seasonParam === 'new' ? null : seasonParam ? seasons.find((s) => String(s.id) === seasonParam) : undefined;

  const openEditor = (target: Season | 'new') => {
    const next = new URLSearchParams(params);
    next.set('season', target === 'new' ? 'new' : String(target.id));
    setParams(next);
    setMessage(null);
  };
  const closeEditor = (force = false) => {
    if (!force && !confirmLeave()) return;
    const next = new URLSearchParams(params);
    next.delete('season');
    setParams(next);
  };

  const remove = async (s: Season) => {
    const crop = cropName(cropById.get(s.crop_id), language, t('seasons.unknownCrop'));
    const period = periodLabel(t, locale, s);
    if (!window.confirm(t('seasons.confirmDelete', { year: period, crop }))) return;
    setBusyId(s.id);
    setMessage(null);
    try {
      await deleteSeason(s.id);
      setSeasons((prev) => prev.filter((x) => x.id !== s.id));
      setApps((prev) => prev.filter((a) => a.season_id !== s.id));
      setProts((prev) => prev.filter((p) => p.season_id !== s.id));
      setIncomes((prev) => prev.filter((i) => i.season_id !== s.id));
      setSeeds((prev) => prev.filter((sd) => sd.season_id !== s.id));
      setIrrigations((prev) => prev.filter((r) => r.season_id !== s.id));
      setMessage({ tone: 'ok', text: t('seasons.deletedNamed', { crop, period }) });
    } catch (err) {
      setMessage({ tone: 'error', text: describeError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  const optionLabel = (detail: (typeof SEASON_DETAILS)[number], value: string | null) => {
    if (!value) return null;
    if (value === UNKNOWN) return t('questionnaire.dontKnow');
    if (detail.type !== 'single') return value;
    const option = detail.options.find((o) => o.value === value);
    return option ? t(option.labelKey) : value;
  };

  if (state === 'loading') {
    return (
      <p className="py-10 text-sm text-cf-muted flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('seasons.loading')}
      </p>
    );
  }

  if (state === 'error') {
    return <ErrorBox message={`${t('seasons.loadFailed')} ${loadError ?? ''}`} onRetry={() => void load()} />;
  }

  if (editing !== undefined) {
    return (
      <SeasonEditor
        key={seasonParam ?? 'new'}
        fieldId={fieldId}
        areaHa={areaHa}
        season={editing}
        seasons={seasons}
        crops={crops}
        products={products}
        applications={editing ? appsBySeason.get(editing.id) ?? [] : []}
        protectionProducts={protProducts}
        protections={editing ? protsBySeason.get(editing.id) ?? [] : []}
        income={editing ? incomeBySeason.get(editing.id) ?? null : null}
        yieldFactors={factors}
        seedVarieties={varieties}
        seeds={editing ? seedsBySeason.get(editing.id) ?? [] : []}
        irrigation={editing ? irrigationBySeason.get(editing.id) ?? null : null}
        irrigationParams={irrParams}
        irrigationBaselines={irrBaselines}
        field={field}
        onSaved={(saved, savedApps, savedProts, savedIncome, savedSeeds, savedIrrigation) => {
          setSeasons((prev) => sortSeasons([...prev.filter((s) => s.id !== saved.id), saved]));
          setApps((prev) => [...prev.filter((a) => a.season_id !== saved.id), ...savedApps]);
          setProts((prev) => [...prev.filter((p) => p.season_id !== saved.id), ...savedProts]);
          setIncomes((prev) => [...prev.filter((i) => i.season_id !== saved.id), ...(savedIncome ? [savedIncome] : [])]);
          setSeeds((prev) => [...prev.filter((sd) => sd.season_id !== saved.id), ...savedSeeds]);
          setIrrigations((prev) => [...prev.filter((r) => r.season_id !== saved.id), ...(savedIrrigation ? [savedIrrigation] : [])]);
          setMessage({
            tone: 'ok',
            text: t('seasons.savedNamed', {
              crop: cropName(cropById.get(saved.crop_id), language, t('seasons.unknownCrop')),
              period: periodLabel(t, locale, saved),
            }),
          });
          closeEditor(true);
        }}
        onClose={() => closeEditor()}
      />
    );
  }

  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  const money = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <p className="text-sm text-cf-muted leading-relaxed max-w-xl">{t('seasons.intro')}</p>
        <button
          type="button"
          onClick={() => openEditor('new')}
          className="cf-btn-primary w-full sm:w-auto px-5 py-3 rounded-lg text-sm flex items-center justify-center gap-2 shrink-0"
        >
          <Plus className="w-4 h-4" />
          {t('seasons.add')}
        </button>
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-cf-primary' : 'text-red-800'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}

      {seasons.length === 0 ? (
        <div className="cf-glass-box rounded-2xl p-8 text-center space-y-2">
          <span className="inline-flex p-3 rounded-full bg-cf-hero/15 text-cf-primary">
            <Sprout className="w-6 h-6" />
          </span>
          <h2 className="text-lg font-semibold text-cf-text">{t('seasons.empty.title')}</h2>
          <p className="text-sm text-cf-muted">{t('seasons.empty.desc')}</p>
        </div>
      ) : (
        <>
          {/* Field calendar */}
          <section className="cf-glass-box rounded-2xl p-5 sm:p-6 space-y-4" aria-labelledby="fs-calendar-title">
            <div className="space-y-1">
              <h2 id="fs-calendar-title" className="text-lg font-semibold text-cf-text flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-cf-primary" />
                {t('seasons.timeline.title')}
              </h2>
              <p className="text-sm text-cf-muted">{t('seasons.timeline.desc')}</p>
            </div>
            <SeasonTimeline seasons={seasons} crops={cropById} onPick={(s) => openEditor(s)} />
          </section>

          {/* Seasons */}
          <ol className="space-y-3">
            {seasons.map((s) => {
              const seasonApps = appsBySeason.get(s.id) ?? [];
              const seasonProts = protsBySeason.get(s.id) ?? [];
              const n = seasonApps.reduce((sum, a) => sum + (nutrientKgPerStremma(a, 'n_pct') ?? 0), 0);
              const seasonSeeds = seedsBySeason.get(s.id) ?? [];
              const water = irrigationCost(s, irrigationBySeason.get(s.id) ?? null, field, irrParams, irrBaselines);
              const cost = seasonCostPerStremma(seasonApps, seasonProts, seasonSeeds, water);
              const showWater = water.basis !== 'not_irrigated' && water.basis !== 'ongoing';
              const seedKg = seasonSeeds.reduce((sum, sd) => sum + (sd.rate_kg_ha ?? 0), 0) / STREMMA_PER_HA;
              const seedNames = [...new Set(seasonSeeds.map((sd) => sd.variety_name).filter((n): n is string => Boolean(n)))];
              const result = seasonRevenue(
                s,
                cropById.get(s.crop_id),
                incomeBySeason.get(s.id) ?? null,
                factors,
                cost.totalHa,
              );
              const margin = result.margin === null ? null : perStremmaEur(result.margin);
              return (
                <li key={s.id} className="cf-glass-box rounded-2xl px-4 sm:px-5 py-4 flex gap-4">
                  <span
                    className="shrink-0 w-1.5 self-stretch rounded-full"
                    style={{ backgroundColor: cropColor(s.crop_id) }}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <p className="text-[0.95rem] font-semibold text-cf-text">
                        {cropName(cropById.get(s.crop_id), language, t('seasons.unknownCrop'))}
                      </p>
                      <p className="text-sm text-cf-primary tabular-nums">
                        {periodLabel(t, locale, s)}
                        {s.sown_on && s.harvested_on && (
                          <span className="text-cf-muted">
                            {' '}
                            · {t('seasons.period.months', { count: String(monthsBetween(s.sown_on, s.harvested_on)) })}
                          </span>
                        )}
                      </p>
                      {s.yield_outcome && (
                        <span className={`px-2 py-0.5 rounded-full border text-xs ${YIELD_TONE[s.yield_outcome]}`}>
                          {optionLabel(YIELD_DETAIL, s.yield_outcome)}
                        </span>
                      )}
                      {!s.sown_on && (
                        <button
                          type="button"
                          onClick={() => openEditor(s)}
                          className="px-2 py-0.5 rounded-full border border-cf-primary/40 bg-cf-hero/10 text-xs text-cf-primary hover:bg-cf-hero/20 cursor-pointer"
                        >
                          {t('seasons.period.noDates')} · {t('seasons.period.addDates')}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {PRACTICE_DETAILS.map((d) => {
                        const label = optionLabel(d, s[d.id] as string | null);
                        return label ? (
                          <span key={d.id} className="px-2 py-0.5 rounded-md bg-cf-panel border border-cf-border text-xs text-cf-muted">
                            <span className="text-cf-muted">{t(d.titleKey)}:</span> {label}
                          </span>
                        ) : null;
                      })}
                      {seasonSeeds.length > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-cf-hero/10 border border-cf-primary/30 text-xs text-cf-muted inline-flex items-center gap-1.5">
                          <Wheat className="w-3 h-3 text-cf-primary" aria-hidden="true" />
                          {seedNames.length > 0 ? t('seasons.seed.summary', { list: seedNames.join(', ') }) : t('seasons.seed.summaryUnknown')}
                          {seedKg > 0 && <span className="text-cf-muted">· {t('seasons.seed.summaryKg', { value: fmt(seedKg) })}</span>}
                        </span>
                      )}
                      {showWater && (
                        <span className="px-2 py-0.5 rounded-md bg-cf-hero/10 border border-cf-primary/30 text-xs text-cf-muted inline-flex items-center gap-1.5 tabular-nums">
                          <Droplets className="w-3 h-3 text-cf-primary" aria-hidden="true" />
                          {water.waterHa != null && water.waterHa > 0
                            ? t('seasons.irrigation.summary', { value: fmt(water.waterHa / STREMMA_PER_HA) })
                            : t('seasons.irrigation.summaryNoWater')}
                          {water.totalEurHa != null && (
                            <span className="text-cf-muted">· {t('seasons.irrigation.summaryCost', { value: money(perStremmaEur(water.totalEurHa)) })}</span>
                          )}
                          {water.estimated && <span className="text-cf-muted">· {t('seasons.income.estimated')}</span>}
                        </span>
                      )}
                      {seasonApps.length > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-cf-hero/10 border border-cf-primary/30 text-xs text-cf-muted inline-flex items-center gap-1.5">
                          <FlaskConical className="w-3 h-3 text-cf-primary" aria-hidden="true" />
                          {t('seasons.fert.summary', { count: String(seasonApps.length) })}
                          {n > 0 && <span className="text-cf-muted">· {t('seasons.fert.summaryN', { value: fmt(n) })}</span>}
                        </span>
                      )}
                      {seasonProts.length > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-cf-hero/10 border border-cf-primary/30 text-xs text-cf-muted inline-flex items-center gap-1.5">
                          <SprayCan className="w-3 h-3 text-cf-primary" aria-hidden="true" />
                          {t('seasons.prot.summary', { count: String(seasonProts.length) })}
                        </span>
                      )}
                      {cost.total !== null && (
                        <span className="px-2 py-0.5 rounded-md bg-cf-hero/10 border border-cf-primary/30 text-xs text-cf-primary inline-flex items-center gap-1.5 tabular-nums">
                          <ReceiptEuro className="w-3 h-3" aria-hidden="true" />
                          {t('seasons.cost.chip', { value: money(cost.total) })}
                          {cost.unpriced > 0 && <span className="text-cf-muted">· {t('seasons.cost.partial')}</span>}
                        </span>
                      )}
                      {margin !== null && (
                        <span
                          className={`px-2 py-0.5 rounded-md border text-xs inline-flex items-center gap-1.5 tabular-nums ${
                            margin >= 0 ? 'bg-cf-hero/10 border-cf-primary/30 text-cf-primary' : 'bg-red-50 border-red-700/30 text-red-900'
                          }`}
                        >
                          {margin >= 0 ? <TrendingUp className="w-3 h-3" aria-hidden="true" /> : <TrendingDown className="w-3 h-3" aria-hidden="true" />}
                          {t('seasons.income.chip', { value: `${margin < 0 ? '−' : '+'}${money(Math.abs(margin))}` })}
                          {result.basis !== 'reported' && result.basis !== 'no_harvest' && (
                            <span className="text-cf-muted">· {t('seasons.income.estimated')}</span>
                          )}
                        </span>
                      )}
                    </div>
                    {s.notes && <p className="text-sm text-cf-muted leading-relaxed break-words">{s.notes}</p>}
                  </div>
                  <div className="shrink-0 flex flex-col sm:flex-row items-end sm:items-start gap-1">
                    <button
                      type="button"
                      onClick={() => openEditor(s)}
                      disabled={busyId === s.id}
                      aria-label={`${t('seasons.edit')} ${periodLabel(t, locale, s)}`}
                      className="p-2 rounded-lg text-cf-muted hover:text-cf-text hover:bg-cf-hero transition-colors cursor-pointer disabled:opacity-40"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(s)}
                      disabled={busyId === s.id}
                      aria-label={`${t('seasons.delete')} ${periodLabel(t, locale, s)}`}
                      className="p-2 rounded-lg text-cf-muted hover:text-red-800 hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {busyId === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <p className="text-xs text-cf-muted leading-relaxed flex gap-2">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-cf-primary" aria-hidden="true" />
        <span>{t('seasons.privacy')}</span>
      </p>
    </div>
  );
};
import React, { useMemo } from 'react';
import { Plus, Sprout, Trash2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import {
  ANALYSIS_KEYS,
  FERT_METHODS,
  MAX_FEE_EUR_STREMMA,
  MAX_PRICE_EUR_KG,
  MAX_RATE_KG_STREMMA,
  NUTRIENTS,
  N_FORMS,
  N_FORMS_ROUNDING,
  STREMMA_PER_HA,
  type AnalysisKey,
  type ApplicationInput,
  type FertMethod,
  type FertilizerApplication,
  type FertilizerProduct,
  type NForm,
  type Nutrient,
} from '../../lib/seasons';
import { WorkBySection } from './WorkBySection';

// The Fertilisers step of a season: one card per application. Choosing a product from the list
// fills in its analysis (with the forms of its nitrogen, when known); a product that is not listed
// is typed by hand with its analysis. Amounts are asked per stremma (0.1 ha) and saved per hectare,
// like a contractor's fee when someone else spread it

export interface FertDraft {
  key: string;
  product_id: number | null;
  custom: boolean;
  product_name: string;
  analysis: Record<AnalysisKey, string>;
  rate: string; // kg per stremma
  price: string; // € per kg
  method: FertMethod | null;
  applied_on: string;
  contractor: boolean;
  fee: string; // € per stremma
}

export const NUTRIENT_LABEL: Record<Nutrient, MessageKey> = {
  n_pct: 'seasons.fert.n',
  p2o5_pct: 'seasons.fert.p',
  k2o_pct: 'seasons.fert.k',
  so3_pct: 'seasons.fert.s',
  cao_pct: 'seasons.fert.ca',
  mgo_pct: 'seasons.fert.mg',
};
export const N_FORM_LABEL: Record<NForm, MessageKey> = {
  n_nh4_pct: 'seasons.fert.nh4',
  n_no3_pct: 'seasons.fert.no3',
  n_urea_pct: 'seasons.fert.urea',
};
// Short names for sums and summaries
export const NUTRIENT_SHORT: Record<Nutrient, string> = {
  n_pct: 'N',
  p2o5_pct: 'P₂O₅',
  k2o_pct: 'K₂O',
  so3_pct: 'SO₃',
  cao_pct: 'CaO',
  mgo_pct: 'MgO',
};

const emptyAnalysis = (): Record<AnalysisKey, string> =>
  Object.fromEntries(ANALYSIS_KEYS.map((n) => [n, ''])) as Record<AnalysisKey, string>;

let keySeq = 0;
const newKey = () => `fert-${Date.now()}-${keySeq++}`;

export const newFertDraft = (): FertDraft => ({
  key: newKey(),
  product_id: null,
  custom: false,
  product_name: '',
  analysis: emptyAnalysis(),
  rate: '',
  price: '',
  method: null,
  applied_on: '',
  contractor: false,
  fee: '',
});

const numText = (v: number | null) => (v == null ? '' : String(Math.round(v * 1000) / 1000));

export function draftFromApplication(a: FertilizerApplication): FertDraft {
  return {
    key: newKey(),
    product_id: a.product_id,
    custom: a.product_id === null,
    product_name: a.product_name,
    analysis: Object.fromEntries(ANALYSIS_KEYS.map((n) => [n, numText(a[n])])) as Record<AnalysisKey, string>,
    rate: a.rate_kg_ha == null ? '' : numText(a.rate_kg_ha / STREMMA_PER_HA),
    price: numText(a.price_eur_kg),
    method: a.method,
    applied_on: a.applied_on ?? '',
    contractor: a.contractor ?? false,
    fee: a.contractor_eur_ha == null ? '' : numText(a.contractor_eur_ha / STREMMA_PER_HA),
  };
}

// "30", "30.5" and "30,5" are numbers; empty is null; anything else is NaN
export function parseNum(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : Number.NaN;
}

export interface FertErrors {
  name?: MessageKey;
  rate?: MessageKey;
  price?: MessageKey;
  analysis?: MessageKey;
  fee?: MessageKey;
}

export function validateFert(d: FertDraft): FertErrors {
  const e: FertErrors = {};
  if (!d.product_id && !d.product_name.trim()) e.name = 'seasons.fert.nameMissing';
  const rate = parseNum(d.rate);
  if (rate !== null && (Number.isNaN(rate) || rate <= 0 || rate > MAX_RATE_KG_STREMMA)) e.rate = 'seasons.fert.rateInvalid';
  const price = parseNum(d.price);
  if (price !== null && (Number.isNaN(price) || price < 0 || price > MAX_PRICE_EUR_KG)) e.price = 'seasons.fert.priceInvalid';
  const fee = parseNum(d.fee);
  if (d.contractor && fee !== null && (Number.isNaN(fee) || fee < 0 || fee > MAX_FEE_EUR_STREMMA)) e.fee = 'seasons.prot.feeInvalid';
  if (d.custom) {
    for (const n of ANALYSIS_KEYS) {
      const v = parseNum(d.analysis[n]);
      if (v !== null && (Number.isNaN(v) || v < 0 || v > 100)) e.analysis = 'seasons.fert.pctInvalid';
    }
    if (!e.analysis) {
      const value = (n: AnalysisKey) => parseNum(d.analysis[n]) ?? 0;
      const forms = N_FORMS.reduce((sum, n) => sum + value(n), 0);
      if (forms > value('n_pct') + N_FORMS_ROUNDING) e.analysis = 'seasons.fert.formsInvalid';
    }
  }
  return e;
}

// The analysis to use for sums: the product's for a listed one, the typed one otherwise
export function draftAnalysis(d: FertDraft, products: Map<number, FertilizerProduct>): Record<AnalysisKey, number | null> {
  const p = d.product_id ? products.get(d.product_id) : undefined;
  return Object.fromEntries(
    ANALYSIS_KEYS.map((n) => {
      if (p) return [n, p[n] ?? null];
      const v = parseNum(d.analysis[n]);
      return [n, v === null || Number.isNaN(v) ? null : v];
    }),
  ) as Record<AnalysisKey, number | null>;
}

export function draftToInput(d: FertDraft, products: Map<number, FertilizerProduct>): ApplicationInput {
  const rate = parseNum(d.rate);
  const price = parseNum(d.price);
  const fee = parseNum(d.fee);
  const p = d.product_id ? products.get(d.product_id) : undefined;
  return {
    product_id: d.product_id,
    product_name: (p?.name ?? d.product_name).trim(),
    ...draftAnalysis(d, products),
    rate_kg_ha: rate === null || Number.isNaN(rate) ? null : Math.round(rate * STREMMA_PER_HA * 1000) / 1000,
    price_eur_kg: price === null || Number.isNaN(price) ? null : price,
    method: d.method,
    applied_on: d.applied_on || null,
    contractor: d.contractor,
    contractor_eur_ha: d.contractor && fee !== null && !Number.isNaN(fee) ? Math.round(fee * STREMMA_PER_HA * 1000) / 1000 : null,
  };
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors aria-[invalid=true]:border-red-400/60';
const CUSTOM = '__custom';

interface Props {
  drafts: FertDraft[];
  onChange: (drafts: FertDraft[]) => void;
  products: FertilizerProduct[];
  // Season period, to flag application dates outside it
  period: { start: string; end: string | null; label: string } | null;
  areaHa: number | null;
  showErrors: boolean;
}

export const FertilizerSection: React.FC<Props> = ({ drafts, onChange, products, period, areaHa, showErrors }) => {
  const { t, locale } = useLanguage();
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Products grouped by brand; common products (no brand) first
  const groups = useMemo(() => {
    const map = new Map<string, FertilizerProduct[]>();
    for (const p of products) {
      const key = p.brand?.trim() || '';
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, locale)));
  }, [products, locale]);

  const fmt = (v: number, max = 2) => v.toLocaleString(locale, { maximumFractionDigits: max });
  const update = (key: string, patch: Partial<FertDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const chooseProduct = (d: FertDraft, value: string) => {
    if (value === CUSTOM) {
      update(d.key, { product_id: null, custom: true, product_name: d.custom ? d.product_name : '' });
      return;
    }
    const p = productById.get(Number(value));
    if (!p) return;
    update(d.key, {
      product_id: p.id,
      custom: false,
      product_name: p.name,
      analysis: Object.fromEntries(ANALYSIS_KEYS.map((n) => [n, numText(p[n] ?? null)])) as Record<AnalysisKey, string>,
    });
  };

  // Season totals per stremma
  const totals = useMemo(() => {
    const kg = Object.fromEntries(ANALYSIS_KEYS.map((n) => [n, 0])) as Record<AnalysisKey, number>;
    let cost = 0;
    let anyCost = false;
    let work = 0;
    let anyWork = false;
    for (const d of drafts) {
      const fee = parseNum(d.fee);
      if (d.contractor && fee !== null && !Number.isNaN(fee)) {
        work += fee;
        anyWork = true;
      }
      const rate = parseNum(d.rate);
      if (rate === null || Number.isNaN(rate)) continue;
      const a = draftAnalysis(d, productById);
      for (const n of ANALYSIS_KEYS) kg[n] += (rate * (a[n] ?? 0)) / 100;
      const price = parseNum(d.price);
      if (price !== null && !Number.isNaN(price)) {
        cost += rate * price;
        anyCost = true;
      }
    }
    return { kg, cost: anyCost ? cost : null, work: anyWork ? work : null };
  }, [drafts, productById]);

  const delivered = (rate: number | null, a: Record<AnalysisKey, number | null>) =>
    rate === null || Number.isNaN(rate)
      ? []
      : NUTRIENTS.filter((n) => (a[n] ?? 0) > 0).map((n) => `${NUTRIENT_SHORT[n]} ${fmt((rate * (a[n] ?? 0)) / 100, 1)} kg`);

  return (
    <div className="space-y-4">
      {drafts.length === 0 && (
        <div className="rounded-xl border border-dashed border-cf-border px-5 py-8 text-center space-y-1">
          <Sprout className="w-6 h-6 text-cf-muted mx-auto" aria-hidden="true" />
          <p className="text-sm text-cf-muted">{t('seasons.fert.empty')}</p>
        </div>
      )}

      {drafts.map((d, i) => {
        const errors = showErrors ? validateFert(d) : {};
        const rate = parseNum(d.rate);
        const price = parseNum(d.price);
        const fee = parseNum(d.fee);
        const hasCost = rate !== null && price !== null && !Number.isNaN(rate) && !Number.isNaN(price);
        const hasWork = d.contractor && fee !== null && !Number.isNaN(fee);
        const analysis = draftAnalysis(d, productById);
        const parts = delivered(rate, analysis);
        const outside =
          period && d.applied_on && (d.applied_on < addDays(period.start, -90) || (period.end && d.applied_on > period.end));
        const selectValue = d.custom ? CUSTOM : d.product_id ? String(d.product_id) : '';
        const id = (f: string) => `fs-fert-${d.key}-${f}`;

        return (
          <fieldset key={d.key} className="min-w-0 rounded-xl border border-cf-border bg-cf-panel/40 overflow-hidden">
            <legend className="sr-only">{t('seasons.fert.itemTitle', { n: String(i + 1) })}</legend>
            <div className="px-4 sm:px-5 py-3 border-b border-cf-border flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-cf-text flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-cf-hero/15 text-cf-primary text-xs inline-flex items-center justify-center tabular-nums shrink-0">
                  {i + 1}
                </span>
                <span className="truncate">{d.product_id || d.product_name ? d.product_name : t('seasons.fert.itemTitle', { n: String(i + 1) })}</span>
              </p>
              <button
                type="button"
                onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                aria-label={t('seasons.fert.removeAria', { n: String(i + 1) })}
                className="text-sm text-cf-muted hover:text-red-800 flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-red-50 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('seasons.fert.remove')}</span>
              </button>
            </div>

            <div className="px-4 sm:px-5 py-4 space-y-4">
              {/* Product */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('product')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.fert.product')}
                  </label>
                  <select
                    id={id('product')}
                    value={selectValue}
                    onChange={(e) => chooseProduct(d, e.target.value)}
                    aria-invalid={errors.name && !d.custom ? true : undefined}
                    className={`${inputCls} cursor-pointer`}
                  >
                    <option value="" disabled>
                      {t('seasons.fert.productPlaceholder')}
                    </option>
                    {groups.map(([brand, list]) => (
                      <optgroup key={brand || '-'} label={brand || t('seasons.fert.common')}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value={CUSTOM}>{t('seasons.fert.custom')}</option>
                  </select>
                </div>
                {d.custom && (
                  <div className="space-y-1.5">
                    <label htmlFor={id('name')} className="text-sm font-medium text-cf-muted">
                      {t('seasons.fert.customName')}
                    </label>
                    <input
                      id={id('name')}
                      value={d.product_name}
                      maxLength={120}
                      onChange={(e) => update(d.key, { product_name: e.target.value })}
                      placeholder={t('seasons.fert.customNamePlaceholder')}
                      aria-invalid={errors.name ? true : undefined}
                      className={inputCls}
                    />
                  </div>
                )}
              </div>
              {errors.name && <p className="text-xs text-red-800 -mt-2">{t(errors.name)}</p>}

              {/* Analysis */}
              {(d.product_id || d.custom) && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-cf-muted">
                    {t('seasons.fert.analysis')}{' '}
                    <span className="font-normal text-cf-muted">
                      {d.custom ? t('seasons.fert.analysisCustom') : t('seasons.fert.analysisAuto')}
                    </span>
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {NUTRIENTS.map((n) => (
                      <div key={n} className="rounded-lg border border-cf-border bg-cf-panel px-3 py-2 min-w-0">
                        <label htmlFor={id(n)} className="block text-[0.7rem] text-cf-muted truncate">
                          {t(NUTRIENT_LABEL[n])}
                        </label>
                        {d.custom ? (
                          <div className="flex items-baseline gap-1">
                            <input
                              id={id(n)}
                              inputMode="decimal"
                              value={d.analysis[n]}
                              onChange={(e) => update(d.key, { analysis: { ...d.analysis, [n]: e.target.value } })}
                              placeholder="0"
                              className="w-full min-w-0 bg-transparent text-sm font-semibold text-cf-text tabular-nums focus:outline-none placeholder:text-cf-muted/60"
                            />
                            <span className="text-xs text-cf-muted">%</span>
                          </div>
                        ) : (
                          <p id={id(n)} className={`text-sm font-semibold tabular-nums ${analysis[n] ? 'text-cf-text' : 'text-cf-muted'}`}>
                            {analysis[n] == null ? '–' : `${fmt(analysis[n]!, 1)}%`}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  {(d.custom || (analysis.n_pct ?? 0) > 0) && (
                    <NitrogenForms
                      custom={d.custom}
                      draft={d}
                      analysis={analysis}
                      inputId={id}
                      fmt={fmt}
                      onEdit={(n, v) => update(d.key, { analysis: { ...d.analysis, [n]: v } })}
                    />
                  )}
                  {errors.analysis && <p className="text-xs text-red-800">{t(errors.analysis)}</p>}
                </div>
              )}

              {/* Amount, price, date */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('rate')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.fert.rate')}
                  </label>
                  <input
                    id={id('rate')}
                    inputMode="decimal"
                    value={d.rate}
                    onChange={(e) => update(d.key, { rate: e.target.value })}
                    placeholder={t('seasons.fert.ratePlaceholder')}
                    aria-invalid={errors.rate ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.rate ? (
                    <p className="text-xs text-red-800">{t(errors.rate)}</p>
                  ) : (
                    rate !== null &&
                    !Number.isNaN(rate) && (
                      <p className="text-xs text-cf-muted tabular-nums">
                        {t('seasons.fert.rateHint', { value: fmt(rate * STREMMA_PER_HA, 1) })}
                      </p>
                    )
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('price')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.fert.price')}
                  </label>
                  <input
                    id={id('price')}
                    inputMode="decimal"
                    value={d.price}
                    onChange={(e) => update(d.key, { price: e.target.value })}
                    placeholder={t('seasons.fert.pricePlaceholder')}
                    aria-invalid={errors.price ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.price ? (
                    <p className="text-xs text-red-800">{t(errors.price)}</p>
                  ) : (
                    price !== null &&
                    !Number.isNaN(price) && (
                      <p className="text-xs text-cf-muted tabular-nums">{t('seasons.fert.priceHint', { value: fmt(price * 50) })}</p>
                    )
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('date')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.fert.date')}
                  </label>
                  <input
                    id={id('date')}
                    type="date"
                    value={d.applied_on}
                    onChange={(e) => update(d.key, { applied_on: e.target.value })}
                    className={`${inputCls} [color-scheme:light]`}
                  />
                  {outside && period && (
                    <p className="text-xs text-cf-primary">{t('seasons.fert.dateOutside', { period: period.label })}</p>
                  )}
                </div>
              </div>

              {/* Method */}
              <div className="space-y-1.5">
                <p id={id('method')} className="text-sm font-medium text-cf-muted">
                  {t('seasons.fert.method')}
                </p>
                <div role="radiogroup" aria-labelledby={id('method')} className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  {FERT_METHODS.map((m) => {
                    const on = d.method === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => update(d.key, { method: on ? null : m })}
                        className={`text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                          on ? 'border-cf-primary/60 bg-cf-hero/15' : 'border-cf-border bg-cf-panel hover:border-cf-border-strong'
                        }`}
                      >
                        <span className={`block text-sm font-medium ${on ? 'text-cf-text' : 'text-cf-muted'}`}>
                          {t(`seasons.fert.methods.${m}`)}
                        </span>
                        <span className="block text-xs text-cf-muted">{t(`seasons.fert.methods.${m}Desc`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Who did the work */}
              <WorkBySection
                idPrefix={`fs-fert-${d.key}`}
                contractor={d.contractor}
                fee={d.fee}
                error={errors.fee}
                onChange={(patch) => update(d.key, patch)}
              />

              {(parts.length > 0 || hasCost || hasWork) && (
                <p className="text-xs text-cf-muted flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                  {parts.length > 0 && <span>{t('seasons.fert.delivers', { list: parts.join(' · ') })}</span>}
                  {hasCost && <span className="text-cf-primary">{t('seasons.fert.cost', { value: fmt(rate! * price!) })}</span>}
                  {hasWork && <span className="text-cf-primary">{t('seasons.prot.costWork', { value: fmt(fee!) })}</span>}
                </p>
              )}
            </div>
          </fieldset>
        );
      })}

      <button
        type="button"
        onClick={() => onChange([...drafts, newFertDraft()])}
        className="w-full rounded-xl border border-dashed border-cf-border-strong px-4 py-3 text-sm font-medium text-cf-muted hover:text-cf-text hover:border-cf-primary/60 hover:bg-cf-hero/5 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        {t('seasons.fert.add')}
      </button>

      {/* Season totals */}
      {drafts.length > 0 && (
        <div className="rounded-xl border border-cf-border bg-cf-panel px-4 sm:px-5 py-4 space-y-3">
          <p className="text-sm font-semibold text-cf-text">{t('seasons.fert.totals')}</p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {NUTRIENTS.map((n) => (
              <div key={n} className="rounded-lg bg-cf-panel border border-cf-border px-2.5 py-2 text-center">
                <p className="text-[0.7rem] text-cf-muted">{NUTRIENT_SHORT[n]}</p>
                <p className={`text-sm font-semibold tabular-nums ${totals.kg[n] > 0 ? 'text-cf-text' : 'text-cf-muted'}`}>
                  {t('seasons.fert.kg', { value: fmt(totals.kg[n], 1) })}
                </p>
              </div>
            ))}
          </div>
          {N_FORMS.some((n) => totals.kg[n] > 0) && (
            <p className="text-xs text-cf-muted tabular-nums">
              {t('seasons.fert.totalsForms', {
                list: N_FORMS.filter((n) => totals.kg[n] > 0)
                  .map((n) => `${t(N_FORM_LABEL[n])} ${t('seasons.fert.kg', { value: fmt(totals.kg[n], 1) })}`)
                  .join(' · '),
              })}
            </p>
          )}
          {totals.cost !== null && totals.work === null && (
            <p className="text-sm text-cf-primary tabular-nums">
              {t('seasons.fert.totalsCost', {
                perStremma: fmt(totals.cost),
                field: areaHa != null ? fmt(totals.cost * areaHa * STREMMA_PER_HA, 0) : '–',
              })}
            </p>
          )}
          {totals.work !== null && (
            <p className="text-sm text-cf-primary tabular-nums">
              {t('seasons.fert.totalsCostWork', {
                products: fmt(totals.cost ?? 0),
                work: fmt(totals.work),
                field: areaHa != null ? fmt(((totals.cost ?? 0) + totals.work) * areaHa * STREMMA_PER_HA, 0) : '–',
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

// The forms of the total nitrogen, under the analysis: typed for a custom product, shown otherwise
const NitrogenForms: React.FC<{
  custom: boolean;
  draft: FertDraft;
  analysis: Record<AnalysisKey, number | null>;
  inputId: (f: string) => string;
  fmt: (v: number, max?: number) => string;
  onEdit: (n: NForm, value: string) => void;
}> = ({ custom, draft, analysis, inputId, fmt, onEdit }) => {
  const { t } = useLanguage();
  const known = N_FORMS.some((n) => analysis[n] != null);
  return (
    <div className="rounded-lg border border-cf-border/70 border-dashed px-3 py-2.5 space-y-2">
      <p className="text-xs text-cf-muted">{t('seasons.fert.nForms')}</p>
      {!custom && !known ? (
        <p className="text-xs text-cf-muted">{t('seasons.fert.formsUnknown')}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {N_FORMS.map((n) => (
            <div key={n} className="rounded-lg border border-cf-border bg-cf-panel px-3 py-2 min-w-0">
              <label htmlFor={inputId(n)} className="block text-[0.7rem] text-cf-muted truncate">
                {t(N_FORM_LABEL[n])}
              </label>
              {custom ? (
                <div className="flex items-baseline gap-1">
                  <input
                    id={inputId(n)}
                    inputMode="decimal"
                    value={draft.analysis[n]}
                    onChange={(e) => onEdit(n, e.target.value)}
                    placeholder="0"
                    className="w-full min-w-0 bg-transparent text-sm font-semibold text-cf-text tabular-nums focus:outline-none placeholder:text-cf-muted/60"
                  />
                  <span className="text-xs text-cf-muted">%</span>
                </div>
              ) : (
                <p id={inputId(n)} className={`text-sm font-semibold tabular-nums ${analysis[n] ? 'text-cf-text' : 'text-cf-muted'}`}>
                  {analysis[n] == null ? '–' : `${fmt(analysis[n]!, 2)}%`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
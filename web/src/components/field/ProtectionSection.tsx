import React, { useMemo } from 'react';
import { Plus, SprayCan, Trash2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import {
  LIQUID_FORMULATIONS,
  MAX_DOSE_PER_STREMMA,
  MAX_FEE_EUR_STREMMA,
  MAX_PRICE_EUR_UNIT,
  ML_PER_STREMMA_PER_L_HA,
  PROTECTION_METHODS,
  PROTECTION_TYPES,
  SOLID_FORMULATIONS,
  STREMMA_PER_HA,
  SUBSTANCES_MAX,
  TARGET_MAX,
  unitOfFormulation,
  type Formulation,
  type ProductUnit,
  type ProtectionApplication,
  type ProtectionInput,
  type ProtectionMethod,
  type ProtectionProduct,
  type ProtectionType,
} from '../../lib/seasons';
import { parseNum } from './FertilizerSection';
import { WorkBySection } from './WorkBySection';

// The Plant protection step of a season: one card per treatment (herbicide, fungicide,
// insecticide...). Choosing a product from the list fills in its type, formulation and active
// substances; a product that is not listed is typed by hand. The dose is asked in ml (liquids) or
// g (solids) per stremma and saved in litres or kg per hectare; a contractor's fee is asked per
// stremma and saved per hectare

export interface ProtDraft {
  key: string;
  product_id: number | null;
  custom: boolean;
  product_name: string;
  product_type: ProtectionType | null;
  formulation: Formulation | null;
  unit: ProductUnit | null;
  active_substances: string;
  target: string;
  dose: string; // ml or g per stremma
  price: string; // € per litre or kg
  method: ProtectionMethod | null;
  applied_on: string;
  contractor: boolean;
  fee: string; // € per stremma
}

let keySeq = 0;
const newKey = () => `prot-${Date.now()}-${keySeq++}`;

export const newProtDraft = (): ProtDraft => ({
  key: newKey(),
  product_id: null,
  custom: false,
  product_name: '',
  product_type: null,
  formulation: null,
  unit: null,
  active_substances: '',
  target: '',
  dose: '',
  price: '',
  method: null,
  applied_on: '',
  contractor: false,
  fee: '',
});

const numText = (v: number | null) => (v == null ? '' : String(Math.round(v * 1000) / 1000));
const valid = (v: number | null): v is number => v !== null && !Number.isNaN(v);

export function draftFromProtection(a: ProtectionApplication): ProtDraft {
  return {
    key: newKey(),
    product_id: a.product_id,
    custom: a.product_id === null,
    product_name: a.product_name,
    product_type: a.product_type,
    formulation: a.formulation,
    unit: a.unit,
    active_substances: a.active_substances ?? '',
    target: a.target ?? '',
    dose: a.dose_per_ha == null ? '' : numText(a.dose_per_ha * ML_PER_STREMMA_PER_L_HA),
    price: numText(a.price_eur_unit),
    method: a.method,
    applied_on: a.applied_on ?? '',
    contractor: a.contractor,
    fee: a.contractor_eur_ha == null ? '' : numText(a.contractor_eur_ha / STREMMA_PER_HA),
  };
}

export interface ProtErrors {
  name?: MessageKey;
  type?: MessageKey;
  unit?: MessageKey;
  dose?: MessageKey;
  price?: MessageKey;
  fee?: MessageKey;
}

export function validateProt(d: ProtDraft): ProtErrors {
  const e: ProtErrors = {};
  if (!d.product_id && !d.product_name.trim()) e.name = 'seasons.fert.nameMissing';
  if (d.custom && !d.product_type) e.type = 'seasons.prot.typeMissing';
  if (d.custom && !d.unit) e.unit = 'seasons.prot.unitMissing';
  const dose = parseNum(d.dose);
  if (dose !== null && (Number.isNaN(dose) || dose <= 0 || dose > MAX_DOSE_PER_STREMMA)) e.dose = 'seasons.prot.doseInvalid';
  const price = parseNum(d.price);
  if (price !== null && (Number.isNaN(price) || price < 0 || price > MAX_PRICE_EUR_UNIT)) e.price = 'seasons.prot.priceInvalid';
  const fee = parseNum(d.fee);
  if (d.contractor && fee !== null && (Number.isNaN(fee) || fee < 0 || fee > MAX_FEE_EUR_STREMMA)) e.fee = 'seasons.prot.feeInvalid';
  return e;
}

// Type, formulation, unit and substances to use: the product's for a listed one, the typed ones otherwise
export function draftDetails(d: ProtDraft, products: Map<number, ProtectionProduct>) {
  const p = d.product_id ? products.get(d.product_id) : undefined;
  return p
    ? { product_type: p.product_type, formulation: p.formulation, unit: p.unit, active_substances: p.active_substances }
    : {
        product_type: d.product_type,
        formulation: d.formulation,
        unit: d.unit,
        active_substances: d.active_substances.trim() || null,
      };
}

export function protToInput(d: ProtDraft, products: Map<number, ProtectionProduct>): ProtectionInput {
  const p = d.product_id ? products.get(d.product_id) : undefined;
  const details = draftDetails(d, products);
  const dose = parseNum(d.dose);
  const price = parseNum(d.price);
  const fee = parseNum(d.fee);
  return {
    product_id: d.product_id,
    product_name: (p?.name ?? d.product_name).trim(),
    product_type: details.product_type ?? 'other',
    formulation: details.formulation,
    unit: details.unit ?? 'l',
    active_substances: details.active_substances,
    target: d.target.trim() || null,
    dose_per_ha: valid(dose) ? Math.round((dose / ML_PER_STREMMA_PER_L_HA) * 100_000) / 100_000 : null,
    price_eur_unit: valid(price) ? price : null,
    method: d.method,
    applied_on: d.applied_on || null,
    contractor: d.contractor,
    contractor_eur_ha: d.contractor && valid(fee) ? Math.round(fee * STREMMA_PER_HA * 1000) / 1000 : null,
  };
}

// Cost per stremma of a treatment: product (dose x price) and work; null when not known
export function protCostPerStremma(d: ProtDraft, products: Map<number, ProtectionProduct>) {
  const dose = parseNum(d.dose);
  const price = parseNum(d.price);
  const fee = parseNum(d.fee);
  return {
    product: valid(dose) && valid(price) ? (dose / 1000) * price : null,
    work: d.contractor && valid(fee) ? fee : null,
    unit: draftDetails(d, products).unit,
  };
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors aria-[invalid=true]:border-red-400/60';
const CUSTOM = '__custom';

const TYPE_TONE: Record<ProtectionType, string> = {
  herbicide: 'bg-cf-hero/15 text-cf-primary border-cf-primary/40',
  fungicide: 'bg-cf-hero/10 text-cf-primary border-cf-primary/40',
  insecticide: 'bg-red-50/15 text-red-800 border-red-800/40',
  acaricide: 'bg-red-50/15 text-red-800 border-red-800/40',
  molluscicide: 'bg-cf-hero/15 text-cf-primary border-cf-primary/40',
  nematicide: 'bg-cf-hero/15 text-cf-primary border-cf-primary/40',
  growth_regulator: 'bg-cf-panel text-cf-muted border-cf-border',
  other: 'bg-cf-panel text-cf-muted border-cf-border',
};

interface Props {
  drafts: ProtDraft[];
  onChange: (drafts: ProtDraft[]) => void;
  products: ProtectionProduct[];
  // Season period, to flag treatment dates outside it
  period: { start: string; end: string | null; label: string } | null;
  areaHa: number | null;
  showErrors: boolean;
}

export const ProtectionSection: React.FC<Props> = ({ drafts, onChange, products, period, areaHa, showErrors }) => {
  const { t, locale } = useLanguage();
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Products grouped by type, in the order of PROTECTION_TYPES
  const groups = useMemo(
    () =>
      PROTECTION_TYPES.map((type) => [type, products.filter((p) => p.product_type === type)] as const).filter(
        ([, list]) => list.length > 0,
      ),
    [products],
  );

  const fmt = (v: number, max = 2) => v.toLocaleString(locale, { maximumFractionDigits: max });
  const update = (key: string, patch: Partial<ProtDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const chooseProduct = (d: ProtDraft, value: string) => {
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
      product_type: p.product_type,
      formulation: p.formulation,
      unit: p.unit,
      active_substances: p.active_substances ?? '',
    });
  };

  const chooseFormulation = (d: ProtDraft, value: string) => {
    const f = (value || null) as Formulation | null;
    update(d.key, { formulation: f, unit: unitOfFormulation(f) ?? d.unit });
  };

  // Season totals per stremma
  const totals = useMemo(() => {
    let product = 0;
    let work = 0;
    let anyProduct = false;
    let anyWork = false;
    const byType = new Map<ProtectionType, number>();
    for (const d of drafts) {
      const c = protCostPerStremma(d, productById);
      if (c.product !== null) {
        product += c.product;
        anyProduct = true;
      }
      if (c.work !== null) {
        work += c.work;
        anyWork = true;
      }
      const type = draftDetails(d, productById).product_type;
      if (type) byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    return { product: anyProduct ? product : null, work: anyWork ? work : null, byType };
  }, [drafts, productById]);

  const totalCost = totals.product === null && totals.work === null ? null : (totals.product ?? 0) + (totals.work ?? 0);

  return (
    <div className="space-y-4">
      {drafts.length === 0 && (
        <div className="rounded-xl border border-dashed border-cf-border px-5 py-8 text-center space-y-1">
          <SprayCan className="w-6 h-6 text-cf-muted mx-auto" aria-hidden="true" />
          <p className="text-sm text-cf-muted">{t('seasons.prot.empty')}</p>
        </div>
      )}

      {drafts.map((d, i) => {
        const errors = showErrors ? validateProt(d) : {};
        const details = draftDetails(d, productById);
        const listed = d.product_id ? productById.get(d.product_id) : undefined;
        const unit = details.unit;
        const dose = parseNum(d.dose);
        const fee = parseNum(d.fee);
        const cost = protCostPerStremma(d, productById);
        const outside =
          period && d.applied_on && (d.applied_on < addDays(period.start, -90) || (period.end && d.applied_on > period.end));
        const selectValue = d.custom ? CUSTOM : d.product_id ? String(d.product_id) : '';
        const id = (f: string) => `fs-prot-${d.key}-${f}`;

        return (
          <fieldset key={d.key} className="min-w-0 rounded-xl border border-cf-border bg-cf-panel/40 overflow-hidden">
            <legend className="sr-only">{t('seasons.prot.itemTitle', { n: String(i + 1) })}</legend>
            <div className="px-4 sm:px-5 py-3 border-b border-cf-border flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-cf-text flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-cf-hero/15 text-cf-primary text-xs inline-flex items-center justify-center tabular-nums shrink-0">
                  {i + 1}
                </span>
                <span className="truncate">
                  {d.product_id || d.product_name ? d.product_name : t('seasons.prot.itemTitle', { n: String(i + 1) })}
                </span>
                {details.product_type && (
                  <span className={`hidden sm:inline px-2 py-0.5 rounded-full border text-[0.7rem] font-medium shrink-0 ${TYPE_TONE[details.product_type]}`}>
                    {t(`seasons.prot.types.${details.product_type}`)}
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                aria-label={t('seasons.prot.removeAria', { n: String(i + 1) })}
                className="text-sm text-cf-muted hover:text-red-800 flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-red-50 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('seasons.prot.remove')}</span>
              </button>
            </div>

            <div className="px-4 sm:px-5 py-4 space-y-4">
              {/* Product */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('product')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.prot.product')}
                  </label>
                  <select
                    id={id('product')}
                    value={selectValue}
                    onChange={(e) => chooseProduct(d, e.target.value)}
                    aria-invalid={errors.name && !d.custom ? true : undefined}
                    className={`${inputCls} cursor-pointer`}
                  >
                    <option value="" disabled>
                      {t('seasons.prot.productPlaceholder')}
                    </option>
                    {groups.map(([type, list]) => (
                      <optgroup key={type} label={t(`seasons.prot.types.${type}`)}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.brand ? `${p.name} (${p.brand})` : p.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value={CUSTOM}>{t('seasons.prot.custom')}</option>
                  </select>
                </div>
                {d.custom && (
                  <div className="space-y-1.5">
                    <label htmlFor={id('name')} className="text-sm font-medium text-cf-muted">
                      {t('seasons.prot.customName')}
                    </label>
                    <input
                      id={id('name')}
                      value={d.product_name}
                      maxLength={120}
                      onChange={(e) => update(d.key, { product_name: e.target.value })}
                      placeholder={t('seasons.prot.customNamePlaceholder')}
                      aria-invalid={errors.name ? true : undefined}
                      className={inputCls}
                    />
                  </div>
                )}
              </div>
              {errors.name && <p className="text-xs text-red-800 -mt-2">{t(errors.name)}</p>}

              {/* Product details: shown for a listed product, typed for a custom one */}
              {listed && (
                <div className="rounded-lg border border-cf-border bg-cf-panel px-3.5 py-3 space-y-2">
                  <p className="text-xs text-cf-muted">{t('seasons.prot.autoInfo')}</p>
                  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-[0.7rem] text-cf-muted">{t('seasons.prot.type')}</dt>
                      <dd className="text-cf-text font-medium">{t(`seasons.prot.types.${listed.product_type}`)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[0.7rem] text-cf-muted">{t('seasons.prot.formulation')}</dt>
                      <dd className="text-cf-text font-medium">
                        {listed.formulation
                          ? `${listed.formulation === 'other' ? '' : `${listed.formulation} · `}${t(`seasons.prot.formulations.${listed.formulation}`)}`
                          : '–'}
                        <span className="text-cf-muted font-normal"> · {t(`seasons.prot.units.${listed.unit}`)}</span>
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[0.7rem] text-cf-muted">{t('seasons.prot.substances')}</dt>
                      <dd className="text-cf-text font-medium break-words">{listed.active_substances || '–'}</dd>
                    </div>
                  </dl>
                  {listed.authorisation_no && (
                    <p className="text-xs text-cf-muted">{t('seasons.prot.registration', { value: listed.authorisation_no })}</p>
                  )}
                </div>
              )}

              {d.custom && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label htmlFor={id('type')} className="text-sm font-medium text-cf-muted">
                        {t('seasons.prot.type')}
                      </label>
                      <select
                        id={id('type')}
                        value={d.product_type ?? ''}
                        onChange={(e) => update(d.key, { product_type: (e.target.value || null) as ProtectionType | null })}
                        aria-invalid={errors.type ? true : undefined}
                        className={`${inputCls} cursor-pointer`}
                      >
                        <option value="" disabled>
                          {t('seasons.prot.typePlaceholder')}
                        </option>
                        {PROTECTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`seasons.prot.types.${type}`)}
                          </option>
                        ))}
                      </select>
                      {errors.type && <p className="text-xs text-red-800">{t(errors.type)}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor={id('formulation')} className="text-sm font-medium text-cf-muted">
                        {t('seasons.prot.formulation')}
                      </label>
                      <select
                        id={id('formulation')}
                        value={d.formulation ?? ''}
                        onChange={(e) => chooseFormulation(d, e.target.value)}
                        className={`${inputCls} cursor-pointer`}
                      >
                        <option value="">{t('seasons.prot.formulationUnknown')}</option>
                        <optgroup label={t('seasons.prot.liquids')}>
                          {LIQUID_FORMULATIONS.map((f) => (
                            <option key={f} value={f}>
                              {f} · {t(`seasons.prot.formulations.${f}`)}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label={t('seasons.prot.solids')}>
                          {SOLID_FORMULATIONS.map((f) => (
                            <option key={f} value={f}>
                              {f} · {t(`seasons.prot.formulations.${f}`)}
                            </option>
                          ))}
                        </optgroup>
                        <option value="other">{t('seasons.prot.formulations.other')}</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <p id={id('unit')} className="text-sm font-medium text-cf-muted">
                      {t('seasons.prot.unit')}
                    </p>
                    <div role="radiogroup" aria-labelledby={id('unit')} className="grid grid-cols-2 gap-2 sm:max-w-md">
                      {(['l', 'kg'] as const).map((u) => {
                        const on = d.unit === u;
                        const locked = unitOfFormulation(d.formulation) !== null && !on;
                        return (
                          <button
                            key={u}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={locked}
                            onClick={() => update(d.key, { unit: u })}
                            className={`text-left rounded-lg border px-3 py-2 text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                              on ? 'border-cf-primary/60 bg-cf-hero/15 text-cf-text' : 'border-cf-border bg-cf-panel text-cf-muted hover:border-cf-border-strong'
                            } ${errors.unit ? 'border-red-400/60' : ''}`}
                          >
                            {t(`seasons.prot.units.${u}`)}
                          </button>
                        );
                      })}
                    </div>
                    {errors.unit && <p className="text-xs text-red-800">{t(errors.unit)}</p>}
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor={id('substances')} className="text-sm font-medium text-cf-muted">
                      {t('seasons.prot.substances')}{' '}
                      <span className="font-normal text-cf-muted">{t('questionnaire.optional')}</span>
                    </label>
                    <input
                      id={id('substances')}
                      value={d.active_substances}
                      maxLength={SUBSTANCES_MAX}
                      onChange={(e) => update(d.key, { active_substances: e.target.value })}
                      placeholder={t('seasons.prot.substancesPlaceholder')}
                      className={inputCls}
                    />
                  </div>
                </div>
              )}

              {/* What it was for */}
              <div className="space-y-1.5">
                <label htmlFor={id('target')} className="text-sm font-medium text-cf-muted">
                  {t('seasons.prot.target')}{' '}
                  <span className="font-normal text-cf-muted">{t('questionnaire.optional')}</span>
                </label>
                <input
                  id={id('target')}
                  value={d.target}
                  maxLength={TARGET_MAX}
                  onChange={(e) => update(d.key, { target: e.target.value })}
                  placeholder={t('seasons.prot.targetPlaceholder')}
                  className={inputCls}
                />
              </div>

              {/* Dose, price, date */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('dose')} className="text-sm font-medium text-cf-muted">
                    {unit === 'l' ? t('seasons.prot.doseMl') : unit === 'kg' ? t('seasons.prot.doseG') : t('seasons.prot.dose')}
                  </label>
                  <input
                    id={id('dose')}
                    inputMode="decimal"
                    value={d.dose}
                    onChange={(e) => update(d.key, { dose: e.target.value })}
                    placeholder={unit === 'kg' ? t('seasons.prot.dosePlaceholderG') : t('seasons.prot.dosePlaceholderMl')}
                    aria-invalid={errors.dose ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.dose ? (
                    <p className="text-xs text-red-800">{t(errors.dose)}</p>
                  ) : (
                    valid(dose) &&
                    unit && (
                      <p className="text-xs text-cf-muted tabular-nums">
                        {t(unit === 'l' ? 'seasons.prot.doseHintL' : 'seasons.prot.doseHintKg', {
                          value: fmt(dose / ML_PER_STREMMA_PER_L_HA, 3),
                        })}
                      </p>
                    )
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('price')} className="text-sm font-medium text-cf-muted">
                    {unit === 'l' ? t('seasons.prot.priceL') : unit === 'kg' ? t('seasons.prot.priceKg') : t('seasons.prot.price')}
                  </label>
                  <input
                    id={id('price')}
                    inputMode="decimal"
                    value={d.price}
                    onChange={(e) => update(d.key, { price: e.target.value })}
                    placeholder={t('seasons.prot.pricePlaceholder')}
                    aria-invalid={errors.price ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.price && <p className="text-xs text-red-800">{t(errors.price)}</p>}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('date')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.prot.date')}
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
                  {t('seasons.prot.method')}
                </p>
                <div role="radiogroup" aria-labelledby={id('method')} className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
                  {PROTECTION_METHODS.map((m) => {
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
                          {t(`seasons.prot.methods.${m}`)}
                        </span>
                        <span className="block text-xs text-cf-muted">{t(`seasons.prot.methods.${m}Desc`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Who did the work */}
              <WorkBySection
                idPrefix={`fs-prot-${d.key}`}
                contractor={d.contractor}
                fee={d.fee}
                error={errors.fee}
                onChange={(patch) => update(d.key, patch)}
              />

              {(cost.product !== null || (d.contractor && valid(fee))) && (
                <p className="text-xs flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                  {cost.product !== null && (
                    <span className="text-cf-primary">{t('seasons.prot.cost', { value: fmt(cost.product) })}</span>
                  )}
                  {cost.work !== null && <span className="text-cf-primary">{t('seasons.prot.costWork', { value: fmt(cost.work) })}</span>}
                </p>
              )}
            </div>
          </fieldset>
        );
      })}

      <button
        type="button"
        onClick={() => onChange([...drafts, newProtDraft()])}
        className="w-full rounded-xl border border-dashed border-cf-border-strong px-4 py-3 text-sm font-medium text-cf-muted hover:text-cf-text hover:border-cf-primary/60 hover:bg-cf-hero/5 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        {t('seasons.prot.add')}
      </button>

      {/* Season totals */}
      {(totals.byType.size > 0 || totalCost !== null) && (
        <div className="rounded-xl border border-cf-border bg-cf-panel px-4 sm:px-5 py-4 space-y-3">
          <p className="text-sm font-semibold text-cf-text">{t('seasons.prot.totals')}</p>
          {totals.byType.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {PROTECTION_TYPES.filter((type) => totals.byType.has(type)).map((type) => (
                <span key={type} className={`px-2 py-0.5 rounded-full border text-xs tabular-nums ${TYPE_TONE[type]}`}>
                  {t(`seasons.prot.types.${type}`)} × {totals.byType.get(type)}
                </span>
              ))}
            </div>
          )}
          {totalCost !== null && (
            <p className="text-sm text-cf-primary tabular-nums">
              {t('seasons.prot.totalsCost', {
                products: fmt(totals.product ?? 0),
                work: fmt(totals.work ?? 0),
                field: areaHa != null ? fmt(totalCost * areaHa * STREMMA_PER_HA, 0) : '–',
              })}
            </p>
          )}
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
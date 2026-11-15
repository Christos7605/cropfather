import React, { useMemo } from 'react';
import { Info, Plus, Trash2, Wheat } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import {
  MAX_FEE_EUR_STREMMA,
  MAX_SEED_KG_STREMMA,
  MAX_SEED_PRICE_EUR_KG,
  SEED_METHODS,
  SEED_ORIGINS,
  STREMMA_PER_HA,
  cropName,
  seedCropsOf,
  type Crop,
  type SeedApplication,
  type SeedInput,
  type SeedMethod,
  type SeedOrigin,
  type SeedVariety,
} from '../../lib/seasons';
import { parseNum } from './FertilizerSection';
import { WorkBySection } from './WorkBySection';

// The Seed step of a season (Σπορά): one card per seed sown. Usually one; two for a mixture such
// as vetch-oat (one per component) or when part of the field was sown again. The variety comes
// from the list of the crop, is typed by hand, or is left as "not known". Rate per stremma, saved
// per hectare, like a contractor's fee for the sowing

export interface SeedDraft {
  key: string;
  // The crop this seed is; for a mixture, one of its components
  crop_id: string | null;
  variety_id: number | null;
  custom: boolean;
  variety_name: string;
  origin: SeedOrigin | null;
  rate: string; // kg per stremma
  price: string; // € per kg
  method: SeedMethod | null;
  sown_on: string;
  contractor: boolean;
  fee: string; // € per stremma
}

let keySeq = 0;
const newKey = () => `seed-${Date.now()}-${keySeq++}`;

export const newSeedDraft = (cropId: string | null = null): SeedDraft => ({
  key: newKey(),
  crop_id: cropId,
  variety_id: null,
  custom: false,
  variety_name: '',
  origin: null,
  rate: '',
  price: '',
  method: null,
  sown_on: '',
  contractor: false,
  fee: '',
});

const numText = (v: number | null, div = 1) => (v == null ? '' : String(Math.round((v / div) * 1000) / 1000));
const valid = (v: number | null): v is number => v !== null && !Number.isNaN(v);

export function draftFromSeed(a: SeedApplication): SeedDraft {
  return {
    key: newKey(),
    crop_id: a.crop_id,
    variety_id: a.variety_id,
    custom: a.variety_id === null && Boolean(a.variety_name),
    variety_name: a.variety_name ?? '',
    origin: a.origin,
    rate: numText(a.rate_kg_ha, STREMMA_PER_HA),
    price: numText(a.price_eur_kg),
    method: a.method,
    sown_on: a.sown_on ?? '',
    contractor: a.contractor,
    fee: numText(a.contractor_eur_ha, STREMMA_PER_HA),
  };
}

export interface SeedErrors {
  name?: MessageKey;
  part?: MessageKey;
  rate?: MessageKey;
  price?: MessageKey;
  fee?: MessageKey;
}

export function validateSeed(d: SeedDraft, seasonCropId: string): SeedErrors {
  const e: SeedErrors = {};
  if (d.custom && !d.variety_name.trim()) e.name = 'seasons.seed.nameMissing';
  if (seedCropsOf(seasonCropId).length > 1 && !d.crop_id) e.part = 'seasons.seed.partMissing';
  const rate = parseNum(d.rate);
  if (rate !== null && (Number.isNaN(rate) || rate <= 0 || rate > MAX_SEED_KG_STREMMA)) e.rate = 'seasons.seed.rateInvalid';
  const price = parseNum(d.price);
  if (price !== null && (Number.isNaN(price) || price < 0 || price > MAX_SEED_PRICE_EUR_KG)) e.price = 'seasons.seed.priceInvalid';
  const fee = parseNum(d.fee);
  if (d.contractor && fee !== null && (Number.isNaN(fee) || fee < 0 || fee > MAX_FEE_EUR_STREMMA)) e.fee = 'seasons.prot.feeInvalid';
  return e;
}

export function seedToInput(d: SeedDraft, varieties: Map<number, SeedVariety>, seasonCropId: string): SeedInput {
  const v = d.variety_id ? varieties.get(d.variety_id) : undefined;
  const rate = parseNum(d.rate);
  const price = parseNum(d.price);
  const fee = parseNum(d.fee);
  const parts = seedCropsOf(seasonCropId);
  return {
    variety_id: d.variety_id,
    crop_id: v?.crop_id ?? (parts.length > 1 ? d.crop_id : seasonCropId),
    variety_name: v?.name ?? (d.custom ? d.variety_name.trim() || null : null),
    origin: d.origin,
    rate_kg_ha: valid(rate) ? Math.round(rate * STREMMA_PER_HA * 1000) / 1000 : null,
    price_eur_kg: valid(price) ? price : null,
    method: d.method,
    sown_on: d.sown_on || null,
    contractor: d.contractor,
    contractor_eur_ha: d.contractor && valid(fee) ? Math.round(fee * STREMMA_PER_HA * 1000) / 1000 : null,
  };
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors aria-[invalid=true]:border-red-400/60';
const CUSTOM = '__custom';

interface Props {
  drafts: SeedDraft[];
  onChange: (drafts: SeedDraft[]) => void;
  crop: Crop | undefined;
  crops: Map<string, Crop>;
  varieties: SeedVariety[];
  // The season's sowing date, shown as the default
  seasonSown: string | null;
  areaHa: number | null;
  showErrors: boolean;
}

export const SeedSection: React.FC<Props> = ({ drafts, onChange, crop, crops, varieties, seasonSown, areaHa, showErrors }) => {
  const { t, language, locale } = useLanguage();
  const varietyById = useMemo(() => new Map(varieties.map((v) => [v.id, v])), [varieties]);
  const fmt = (v: number, max = 2) => v.toLocaleString(locale, { maximumFractionDigits: max });
  const update = (key: string, patch: Partial<SeedDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  if (!crop) return <Notice text={t('seasons.seed.chooseCrop')} />;
  if (crop.main_product === 'none') return <Notice text={t('seasons.seed.fallow')} />;

  const parts = seedCropsOf(crop.id);
  const mixture = parts.length > 1;
  const nameOf = (id: string) => cropName(crops.get(id), language, id);
  const fieldStremmata = areaHa != null ? areaHa * STREMMA_PER_HA : null;

  // Season totals per stremma
  let kg = 0;
  let cost = 0;
  let anyCost = false;
  let work = 0;
  let anyWork = false;
  for (const d of drafts) {
    const rate = parseNum(d.rate);
    const price = parseNum(d.price);
    const fee = parseNum(d.fee);
    if (valid(rate)) kg += rate;
    if (valid(rate) && valid(price)) {
      cost += rate * price;
      anyCost = true;
    }
    if (d.contractor && valid(fee)) {
      work += fee;
      anyWork = true;
    }
  }

  return (
    <div className="space-y-4">
      {drafts.length === 0 && (
        <div className="rounded-xl border border-dashed border-cf-border px-5 py-8 text-center space-y-1">
          <Wheat className="w-6 h-6 text-cf-muted mx-auto" aria-hidden="true" />
          <p className="text-sm text-cf-muted">{t('seasons.seed.empty')}</p>
        </div>
      )}

      {drafts.map((d, i) => {
        const errors = showErrors ? validateSeed(d, crop.id) : {};
        const partCrop = mixture ? d.crop_id : crop.id;
        const list = partCrop ? varieties.filter((v) => v.crop_id === partCrop) : [];
        const rate = parseNum(d.rate);
        const price = parseNum(d.price);
        const fee = parseNum(d.fee);
        const id = (f: string) => `fs-seed-${d.key}-${f}`;
        const selectValue = d.custom ? CUSTOM : d.variety_id ? String(d.variety_id) : '';
        const title =
          (d.variety_id ? varietyById.get(d.variety_id)?.name : d.custom ? d.variety_name.trim() : '') ||
          (partCrop ? nameOf(partCrop) : t('seasons.seed.itemTitle', { n: String(i + 1) }));

        return (
          <fieldset key={d.key} className="min-w-0 rounded-xl border border-cf-border bg-cf-panel/40 overflow-hidden">
            <legend className="sr-only">{t('seasons.seed.itemTitle', { n: String(i + 1) })}</legend>
            <div className="px-4 sm:px-5 py-3 border-b border-cf-border flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-cf-text flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-cf-hero/15 text-cf-primary text-xs inline-flex items-center justify-center tabular-nums shrink-0">
                  {i + 1}
                </span>
                <span className="truncate">{title}</span>
              </p>
              <button
                type="button"
                onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                aria-label={t('seasons.seed.removeAria', { n: String(i + 1) })}
                className="text-sm text-cf-muted hover:text-red-800 flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-red-50 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('seasons.seed.remove')}</span>
              </button>
            </div>

            <div className="px-4 sm:px-5 py-4 space-y-4">
              {/* Which crop's seed (mixtures only) */}
              {mixture && (
                <div className="space-y-1.5">
                  <p id={id('part')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.seed.part', { crop: nameOf(crop.id) })}
                  </p>
                  <div role="radiogroup" aria-labelledby={id('part')} className="flex flex-wrap gap-2">
                    {parts.map((p) => {
                      const on = d.crop_id === p;
                      return (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => update(d.key, { crop_id: p, variety_id: null, custom: false, variety_name: '' })}
                          className={`rounded-lg border px-3.5 py-2 text-sm transition-colors cursor-pointer ${
                            on ? 'border-cf-primary/60 bg-cf-hero/15 text-cf-text' : 'border-cf-border bg-cf-panel text-cf-muted hover:border-cf-border-strong'
                          } ${errors.part ? 'border-red-400/60' : ''}`}
                        >
                          {nameOf(p)}
                        </button>
                      );
                    })}
                  </div>
                  {errors.part && <p className="text-xs text-red-800">{t(errors.part)}</p>}
                </div>
              )}

              {/* Variety */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('variety')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.seed.variety')}
                  </label>
                  <select
                    id={id('variety')}
                    value={selectValue}
                    disabled={mixture && !d.crop_id}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === CUSTOM) update(d.key, { variety_id: null, custom: true });
                      else if (!value) update(d.key, { variety_id: null, custom: false, variety_name: '' });
                      else update(d.key, { variety_id: Number(value), custom: false, variety_name: '' });
                    }}
                    className={`${inputCls} cursor-pointer disabled:opacity-50`}
                  >
                    <option value="">{t('seasons.seed.varietyUnknown')}</option>
                    {list.length > 0 && (
                      <optgroup label={t('seasons.seed.varietiesOf', { crop: nameOf(partCrop!) })}>
                        {list.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.breeder ? `${v.name} (${v.breeder})` : v.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value={CUSTOM}>{t('seasons.seed.custom')}</option>
                  </select>
                </div>
                {d.custom && (
                  <div className="space-y-1.5">
                    <label htmlFor={id('name')} className="text-sm font-medium text-cf-muted">
                      {t('seasons.seed.customName')}
                    </label>
                    <input
                      id={id('name')}
                      value={d.variety_name}
                      maxLength={120}
                      onChange={(e) => update(d.key, { variety_name: e.target.value })}
                      placeholder={t('seasons.seed.customNamePlaceholder')}
                      aria-invalid={errors.name ? true : undefined}
                      className={inputCls}
                    />
                    {errors.name && <p className="text-xs text-red-800">{t(errors.name)}</p>}
                  </div>
                )}
              </div>

              {/* Origin */}
              <div className="space-y-1.5">
                <p id={id('origin')} className="text-sm font-medium text-cf-muted">
                  {t('seasons.seed.origin')}
                </p>
                <div role="radiogroup" aria-labelledby={id('origin')} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {SEED_ORIGINS.map((o) => {
                    const on = d.origin === o;
                    return (
                      <button
                        key={o}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => update(d.key, { origin: on ? null : o })}
                        className={`text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                          on ? 'border-cf-primary/60 bg-cf-hero/15' : 'border-cf-border bg-cf-panel hover:border-cf-border-strong'
                        }`}
                      >
                        <span className={`block text-sm font-medium ${on ? 'text-cf-text' : 'text-cf-muted'}`}>
                          {t(`seasons.seed.origins.${o}`)}
                        </span>
                        <span className="block text-xs text-cf-muted">{t(`seasons.seed.origins.${o}Desc`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Rate, price, date */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={id('rate')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.seed.rate')}
                  </label>
                  <input
                    id={id('rate')}
                    inputMode="decimal"
                    value={d.rate}
                    onChange={(e) => update(d.key, { rate: e.target.value })}
                    placeholder={t('seasons.seed.ratePlaceholder')}
                    aria-invalid={errors.rate ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.rate ? (
                    <p className="text-xs text-red-800">{t(errors.rate)}</p>
                  ) : valid(rate) ? (
                    <p className="text-xs text-cf-muted tabular-nums">
                      {fieldStremmata != null
                        ? t('seasons.seed.rateHintField', { ha: fmt(rate * STREMMA_PER_HA, 1), field: fmt(rate * fieldStremmata, 0) })
                        : t('seasons.seed.rateHint', { ha: fmt(rate * STREMMA_PER_HA, 1) })}
                    </p>
                  ) : (
                    <p className="text-xs text-cf-muted">{t('seasons.seed.rateHelp')}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('price')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.seed.price')}
                  </label>
                  <input
                    id={id('price')}
                    inputMode="decimal"
                    value={d.price}
                    onChange={(e) => update(d.key, { price: e.target.value })}
                    placeholder={t('seasons.seed.pricePlaceholder')}
                    aria-invalid={errors.price ? true : undefined}
                    className={`${inputCls} tabular-nums`}
                  />
                  {errors.price ? (
                    <p className="text-xs text-red-800">{t(errors.price)}</p>
                  ) : (
                    <p className="text-xs text-cf-muted">
                      {t(d.origin === 'own' ? 'seasons.seed.priceOwn' : 'seasons.seed.priceHelp')}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={id('date')} className="text-sm font-medium text-cf-muted">
                    {t('seasons.seed.date')}
                  </label>
                  <input
                    id={id('date')}
                    type="date"
                    value={d.sown_on}
                    onChange={(e) => update(d.key, { sown_on: e.target.value })}
                    className={`${inputCls} [color-scheme:light]`}
                  />
                  {!d.sown_on && seasonSown && <p className="text-xs text-cf-muted">{t('seasons.seed.dateDefault')}</p>}
                </div>
              </div>

              {/* Method */}
              <div className="space-y-1.5">
                <p id={id('method')} className="text-sm font-medium text-cf-muted">
                  {t('seasons.seed.method')}
                </p>
                <div role="radiogroup" aria-labelledby={id('method')} className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  {SEED_METHODS.map((m) => {
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
                          {t(`seasons.seed.methods.${m}`)}
                        </span>
                        <span className="block text-xs text-cf-muted">{t(`seasons.seed.methods.${m}Desc`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <WorkBySection
                idPrefix={`fs-seed-${d.key}`}
                contractor={d.contractor}
                fee={d.fee}
                error={errors.fee}
                onChange={(patch) => update(d.key, patch)}
              />

              {((valid(rate) && valid(price)) || (d.contractor && valid(fee))) && (
                <p className="text-xs flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                  {valid(rate) && valid(price) && (
                    <span className="text-cf-primary">{t('seasons.seed.cost', { value: fmt(rate * price) })}</span>
                  )}
                  {d.contractor && valid(fee) && <span className="text-cf-primary">{t('seasons.prot.costWork', { value: fmt(fee) })}</span>}
                </p>
              )}
            </div>
          </fieldset>
        );
      })}

      <button
        type="button"
        onClick={() => onChange([...drafts, newSeedDraft(mixture ? null : crop.id)])}
        className="w-full rounded-xl border border-dashed border-cf-border-strong px-4 py-3 text-sm font-medium text-cf-muted hover:text-cf-text hover:border-cf-primary/60 hover:bg-cf-hero/5 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        {t(drafts.length === 0 ? 'seasons.seed.add' : 'seasons.seed.addAnother')}
      </button>

      {(kg > 0 || anyCost || anyWork) && (
        <div className="rounded-xl border border-cf-border bg-cf-panel px-4 sm:px-5 py-4 space-y-1.5">
          <p className="text-sm font-semibold text-cf-text">{t('seasons.seed.totals')}</p>
          {kg > 0 && (
            <p className="text-sm text-cf-muted tabular-nums">
              {fieldStremmata != null
                ? t('seasons.seed.totalsKgField', { value: fmt(kg, 1), field: fmt(kg * fieldStremmata, 0) })
                : t('seasons.seed.totalsKg', { value: fmt(kg, 1) })}
            </p>
          )}
          {(anyCost || anyWork) && (
            <p className="text-sm text-cf-primary tabular-nums">
              {t('seasons.seed.totalsCost', {
                seed: fmt(cost),
                work: fmt(work),
                field: fieldStremmata != null ? fmt((cost + work) * fieldStremmata, 0) : '–',
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const Notice: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-xl border border-dashed border-cf-border px-5 py-6 flex gap-3 text-sm text-cf-muted">
    <Info className="w-5 h-5 text-cf-muted shrink-0" aria-hidden="true" />
    <p className="leading-relaxed">{text}</p>
  </div>
);
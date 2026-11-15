import React from 'react';
import { Clock, EyeOff, HandCoins, Info, TrendingDown, TrendingUp } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import {
  INCOME_LIMITS,
  STREMMA_PER_HA,
  perStremmaEur,
  seasonRevenue,
  type Crop,
  type IncomeInput,
  type Revenue,
  type Season,
  type SeasonIncome,
  type YieldFactors,
} from '../../lib/seasons';
import { parseNum } from './FertilizerSection';

// The Income step of a season: what the harvest earned. The farmer gives the main product
// (quantity, moisture, price), the straw for crops that have it, aid tied to this crop and other
// income, all per stremma; or prefers not to say, and the income is estimated from the regional
// average and their answer to "How did the harvest go?". The result card puts the income next to
// the costs of the Fertilisers and Plant protection steps. Same rules as the view season_finance

export interface IncomeDraft {
  disclosed: boolean;
  main: string; // kg per stremma
  mainMoisture: string; // %
  mainPrice: string; // € per kg
  straw: string; // kg per stremma
  strawMoisture: string; // %
  strawPrice: string; // € per kg
  subsidy: string; // € per stremma
  other: string; // € per stremma
}

const numText = (v: number | null, div = 1) => (v == null ? '' : String(Math.round((v / div) * 1000) / 1000));

export const emptyIncomeDraft = (): IncomeDraft => ({
  disclosed: true,
  main: '',
  mainMoisture: '',
  mainPrice: '',
  straw: '',
  strawMoisture: '',
  strawPrice: '',
  subsidy: '',
  other: '',
});

export function incomeDraftFrom(i: SeasonIncome | null): IncomeDraft {
  if (!i) return emptyIncomeDraft();
  return {
    disclosed: i.disclosed,
    main: numText(i.main_kg_ha, STREMMA_PER_HA),
    mainMoisture: numText(i.main_moisture_pct),
    mainPrice: numText(i.main_price_eur_kg),
    straw: numText(i.straw_kg_ha, STREMMA_PER_HA),
    strawMoisture: numText(i.straw_moisture_pct),
    strawPrice: numText(i.straw_price_eur_kg),
    subsidy: numText(i.subsidy_eur_ha, STREMMA_PER_HA),
    other: numText(i.other_income_eur_ha, STREMMA_PER_HA),
  };
}

// True when nothing has been filled in (and the farmer has not chosen "prefer not to say")
export function incomeDraftEmpty(d: IncomeDraft): boolean {
  return d.disclosed && [d.main, d.mainMoisture, d.mainPrice, d.straw, d.strawMoisture, d.strawPrice, d.subsidy, d.other].every((v) => !v.trim());
}

type Field = 'main' | 'mainMoisture' | 'mainPrice' | 'straw' | 'strawMoisture' | 'strawPrice' | 'subsidy' | 'other';
export type IncomeErrors = Partial<Record<Field, MessageKey>>;

const LIMIT: Record<Field, { max: number; key: MessageKey }> = {
  main: { max: INCOME_LIMITS.mainKg, key: 'seasons.income.invalid.quantity' },
  mainMoisture: { max: INCOME_LIMITS.moisture, key: 'seasons.income.invalid.moisture' },
  mainPrice: { max: INCOME_LIMITS.mainPrice, key: 'seasons.income.invalid.price' },
  straw: { max: INCOME_LIMITS.strawKg, key: 'seasons.income.invalid.strawQuantity' },
  strawMoisture: { max: INCOME_LIMITS.moisture, key: 'seasons.income.invalid.moisture' },
  strawPrice: { max: INCOME_LIMITS.strawPrice, key: 'seasons.income.invalid.strawPrice' },
  subsidy: { max: INCOME_LIMITS.subsidy, key: 'seasons.income.invalid.subsidy' },
  other: { max: INCOME_LIMITS.other, key: 'seasons.income.invalid.other' },
};

export function validateIncome(d: IncomeDraft): IncomeErrors {
  const e: IncomeErrors = {};
  if (!d.disclosed) return e;
  for (const f of Object.keys(LIMIT) as Field[]) {
    const v = parseNum(d[f]);
    if (v !== null && (Number.isNaN(v) || v < 0 || v > LIMIT[f].max)) e[f] = LIMIT[f].key;
  }
  // Straw counts only with both figures
  if (!e.straw && !e.strawPrice && Boolean(d.straw.trim()) !== Boolean(d.strawPrice.trim())) {
    e[d.straw.trim() ? 'strawPrice' : 'straw'] = 'seasons.income.invalid.strawBoth';
  }
  return e;
}

// What save_season receives (per hectare); figures of a "prefer not to say" are left empty
export function incomeToInput(d: IncomeDraft): IncomeInput {
  const n = (text: string, mult = 1) => {
    const v = parseNum(text);
    return v === null || Number.isNaN(v) || !d.disclosed ? null : Math.round(v * mult * 1000) / 1000;
  };
  return {
    disclosed: d.disclosed,
    main_kg_ha: n(d.main, STREMMA_PER_HA),
    main_moisture_pct: n(d.mainMoisture),
    main_price_eur_kg: n(d.mainPrice),
    straw_kg_ha: n(d.straw, STREMMA_PER_HA),
    straw_moisture_pct: n(d.strawMoisture),
    straw_price_eur_kg: n(d.strawPrice),
    subsidy_eur_ha: n(d.subsidy, STREMMA_PER_HA),
    other_income_eur_ha: n(d.other, STREMMA_PER_HA),
  };
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg pl-3.5 pr-16 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors tabular-nums aria-[invalid=true]:border-red-400/60';

interface Props {
  draft: IncomeDraft;
  onChange: (draft: IncomeDraft) => void;
  crop: Crop | undefined;
  season: Pick<Season, 'sown_on' | 'harvested_on' | 'yield_outcome'>;
  factors: YieldFactors;
  // Recorded costs of the season (Fertilisers and Plant protection steps), per stremma
  costs: { total: number | null; totalHa: number | null; unpriced: number };
  areaHa: number | null;
  cropLabel: string;
  showErrors: boolean;
  extraCost: string;
  onExtraCost: (value: string) => void;
  extraError?: MessageKey | null;
}

export const IncomeSection: React.FC<Props> = ({
  draft,
  onChange,
  crop,
  season,
  factors,
  costs,
  areaHa,
  cropLabel,
  showErrors,
  extraCost,
  onExtraCost,
  extraError,
}) => {
  const { t, locale } = useLanguage();
  const errors = showErrors ? validateIncome(draft) : {};
  const set = (patch: Partial<IncomeDraft>) => onChange({ ...draft, ...patch });
  const fmt = (v: number, max = 2) => v.toLocaleString(locale, { maximumFractionDigits: max });
  const money = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const extraField = (
    <Group title={t('seasons.income.otherCosts')} desc={t('seasons.income.otherCostsDesc')}>
      <NumberField
        id="fs-extra-cost"
        label={t('seasons.income.otherCosts')}
        unit={t('seasons.income.unitEurStremma')}
        value={extraCost}
        onChange={onExtraCost}
        placeholder="0"
        hint={t('seasons.income.otherCostsHint')}
        error={extraError ?? undefined}
      />
    </Group>
  );

  if (!crop) {
    return <Notice icon={Info} text={t('seasons.income.chooseCrop')} />;
  }
  if (season.sown_on && !season.harvested_on) {
    return (
      <div className="space-y-5">
        {extraField}
        <Notice icon={Clock} text={t('seasons.income.ongoing')} />
      </div>
    );
  }

  const product = crop.main_product ?? 'other';
  const fallow = product === 'none';
  const hasStraw = crop.byproduct === 'straw';
  const result: Revenue = seasonRevenue(
    season,
    crop,
    incomeToInput(draft),
    factors,
    costs.totalHa,
  );
  const perStremma = (v: number | null) => (v === null ? null : perStremmaEur(v));
  const refKgStremma = crop.yield_kg_ha != null ? crop.yield_kg_ha / STREMMA_PER_HA : null;
  const outcome = season.yield_outcome ?? 'unknown';

  const tons = (kgStremma: string) => {
    const v = parseNum(kgStremma);
    if (v === null || Number.isNaN(v) || areaHa == null) return null;
    return t('seasons.income.fieldTons', { value: fmt((v * areaHa * STREMMA_PER_HA) / 1000, 2) });
  };

  const estimateText = () => {
    if (result.basis === 'no_reference') return t('seasons.income.basis.no_reference', { crop: cropLabel });
    if (result.basis === 'no_harvest') return t('seasons.income.basis.no_harvest');
    if (result.basis === 'reported') return t('seasons.income.basis.reported');
    const parts = {
      kg: fmt(refKgStremma ?? 0, 0),
      factor: fmt(result.factor, 2),
      outcome: t(outcome === 'unknown' ? 'seasons.income.outcomeUnknown' : `seasons.q.yield.${outcome}`),
      price: fmt(crop.price_eur_kg ?? 0, 3),
    };
    return t(`seasons.income.basis.${result.basis}`, parts);
  };

  const margin = perStremma(result.margin);

  return (
    <div className="space-y-5">
      {/* Share figures or not */}
      <div className="space-y-1.5">
        <p id="fs-income-share" className="text-sm font-medium text-cf-muted">
          {t('seasons.income.share')}
        </p>
        <div role="radiogroup" aria-labelledby="fs-income-share" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {([true, false] as const).map((on) => {
            const active = draft.disclosed === on;
            return (
              <button
                key={String(on)}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => set({ disclosed: on })}
                className={`text-left rounded-lg border px-3.5 py-3 transition-colors cursor-pointer flex gap-3 ${
                  active ? 'border-cf-primary/60 bg-cf-hero/15' : 'border-cf-border bg-cf-panel hover:border-cf-border-strong'
                }`}
              >
                {on ? (
                  <HandCoins className={`w-4 h-4 mt-0.5 shrink-0 ${active ? 'text-cf-primary' : 'text-cf-muted'}`} />
                ) : (
                  <EyeOff className={`w-4 h-4 mt-0.5 shrink-0 ${active ? 'text-cf-primary' : 'text-cf-muted'}`} />
                )}
                <span>
                  <span className={`block text-sm font-medium ${active ? 'text-cf-text' : 'text-cf-muted'}`}>
                    {t(on ? 'seasons.income.shareYes' : 'seasons.income.shareNo')}
                  </span>
                  <span className="block text-xs text-cf-muted">
                    {t(on ? 'seasons.income.shareYesDesc' : 'seasons.income.shareNoDesc')}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {draft.disclosed && (
        <>
          {/* Main product */}
          {fallow ? (
            <Notice icon={Info} text={t('seasons.income.fallow')} />
          ) : (
            <Group title={t(`seasons.income.products.${product}`)} desc={t('seasons.income.mainDesc')}>
              <NumberField
                id="fs-income-main"
                label={t('seasons.income.quantity')}
                unit={t('seasons.income.unitKgStremma')}
                value={draft.main}
                onChange={(v) => set({ main: v })}
                placeholder={refKgStremma != null ? fmt(refKgStremma, 0) : t('seasons.income.quantityPlaceholder')}
                hint={tons(draft.main) ?? (refKgStremma != null ? t('seasons.income.refQuantity', { value: fmt(refKgStremma, 0) }) : undefined)}
                error={errors.main}
              />
              <NumberField
                id="fs-income-main-moisture"
                label={t('seasons.income.moisture')}
                unit="%"
                optional
                value={draft.mainMoisture}
                onChange={(v) => set({ mainMoisture: v })}
                placeholder={t('seasons.income.moisturePlaceholder')}
                hint={t('seasons.income.moistureHint')}
                error={errors.mainMoisture}
              />
              <NumberField
                id="fs-income-main-price"
                label={t('seasons.income.price')}
                unit="€/kg"
                value={draft.mainPrice}
                onChange={(v) => set({ mainPrice: v })}
                placeholder={crop.price_eur_kg != null ? fmt(crop.price_eur_kg, 3) : t('seasons.income.pricePlaceholder')}
                hint={
                  crop.price_eur_kg != null
                    ? t(crop.price_kind !== 'market' ? 'seasons.income.refPriceIndicative' : 'seasons.income.refPrice', {
                        value: fmt(crop.price_eur_kg, 3),
                      })
                    : t('seasons.income.priceHint')
                }
                error={errors.mainPrice}
              />
            </Group>
          )}

          {/* Straw */}
          {hasStraw && (
            <Group title={t('seasons.income.straw')} desc={t('seasons.income.strawDesc')} optional>
              <NumberField
                id="fs-income-straw"
                label={t('seasons.income.quantity')}
                unit={t('seasons.income.unitKgStremma')}
                value={draft.straw}
                onChange={(v) => set({ straw: v })}
                placeholder={t('seasons.income.strawPlaceholder')}
                hint={tons(draft.straw) ?? undefined}
                error={errors.straw}
              />
              <NumberField
                id="fs-income-straw-moisture"
                label={t('seasons.income.moisture')}
                unit="%"
                optional
                value={draft.strawMoisture}
                onChange={(v) => set({ strawMoisture: v })}
                placeholder={t('seasons.income.moisturePlaceholder')}
                error={errors.strawMoisture}
              />
              <NumberField
                id="fs-income-straw-price"
                label={t('seasons.income.price')}
                unit="€/kg"
                value={draft.strawPrice}
                onChange={(v) => set({ strawPrice: v })}
                placeholder={t('seasons.income.strawPricePlaceholder')}
                error={errors.strawPrice}
              />
            </Group>
          )}

          {/* Aid and other income */}
          <Group title={t('seasons.income.extra')} desc={t('seasons.income.extraDesc')} optional columns={2}>
            <NumberField
              id="fs-income-subsidy"
              label={t('seasons.income.subsidy')}
              unit={t('seasons.income.unitEurStremma')}
              value={draft.subsidy}
              onChange={(v) => set({ subsidy: v })}
              placeholder="0"
              hint={t('seasons.income.subsidyHint')}
              error={errors.subsidy}
            />
            <NumberField
              id="fs-income-other"
              label={t('seasons.income.other')}
              unit={t('seasons.income.unitEurStremma')}
              value={draft.other}
              onChange={(v) => set({ other: v })}
              placeholder="0"
              hint={t('seasons.income.otherHint')}
              error={errors.other}
            />
          </Group>
        </>
      )}

      {extraField}

      {/* Result */}
      <section className="rounded-xl border border-cf-border bg-cf-panel px-4 sm:px-5 py-4 space-y-3" aria-labelledby="fs-income-result">
        <h4 id="fs-income-result" className="text-sm font-semibold text-cf-text">
          {t('seasons.income.resultTitle')}
        </h4>
        <p className="text-xs text-cf-muted leading-relaxed">{estimateText()}</p>
        {result.revenue !== null && (
          <dl className="text-sm divide-y divide-cf-border/60 tabular-nums">
            {!fallow && (
              <Row
                label={t(`seasons.income.products.${product}`)}
                detail={
                  result.mainKgHa !== null && result.mainPrice !== null
                    ? t('seasons.income.rowMain', {
                        kg: fmt(result.mainKgHa / STREMMA_PER_HA, 1),
                        price: fmt(result.mainPrice, 3),
                      })
                    : undefined
                }
                value={money(perStremma(result.main)!)}
                tag={result.basis !== 'reported' ? t('seasons.income.estimated') : undefined}
              />
            )}
            {(result.straw ?? 0) > 0 && <Row label={t('seasons.income.straw')} value={money(perStremma(result.straw)!)} />}
            {(result.subsidy ?? 0) > 0 && <Row label={t('seasons.income.subsidy')} value={money(perStremma(result.subsidy)!)} />}
            {(result.other ?? 0) > 0 && <Row label={t('seasons.income.other')} value={money(perStremma(result.other)!)} />}
            <Row label={t('seasons.income.totalIncome')} value={money(perStremma(result.revenue)!)} strong />
            <Row
              label={t('seasons.income.costs')}
              detail={costs.unpriced > 0 ? t('seasons.cost.partial') : costs.total === null ? t('seasons.income.noCosts') : undefined}
              value={`− ${money(costs.total ?? 0)}`}
            />
          </dl>
        )}
        {margin !== null && (
          <div
            className={`rounded-lg border px-3.5 py-3 flex flex-wrap items-center justify-between gap-2 ${
              margin >= 0 ? 'border-cf-primary/40 bg-cf-hero/10' : 'border-red-700/30 bg-red-950/30'
            }`}
          >
            <p className={`text-sm font-semibold flex items-center gap-2 ${margin >= 0 ? 'text-cf-primary' : 'text-red-900'}`}>
              {margin >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {t(margin >= 0 ? 'seasons.income.profit' : 'seasons.income.loss')}
            </p>
            <p className="text-sm tabular-nums text-cf-text">
              <span className="font-semibold">{t('seasons.income.perStremma', { value: signed(margin, money) })}</span>
              {areaHa != null && (
                <span className="text-cf-muted">
                  {' '}
                  · {t('seasons.income.forField', { value: signed(result.margin! * areaHa, (v) => fmt(v, 0)) })}
                </span>
              )}
            </p>
          </div>
        )}
        {margin !== null && <p className="text-xs text-cf-muted leading-relaxed">{t('seasons.income.marginNote')}</p>}
      </section>
    </div>
  );
};

const signed = (v: number, f: (v: number) => string) => (v < 0 ? `−${f(Math.abs(v))}` : `+${f(v)}`);

const Notice: React.FC<{ icon: React.ComponentType<{ className?: string }>; text: string }> = ({ icon: Icon, text }) => (
  <div className="rounded-xl border border-dashed border-cf-border px-5 py-6 flex gap-3 text-sm text-cf-muted">
    <Icon className="w-5 h-5 text-cf-muted shrink-0" aria-hidden="true" />
    <p className="leading-relaxed">{text}</p>
  </div>
);

const Group: React.FC<{ title: string; desc: string; optional?: boolean; columns?: 2 | 3; children: React.ReactNode }> = ({
  title,
  desc,
  optional,
  columns = 3,
  children,
}) => {
  const { t } = useLanguage();
  return (
    <fieldset className="min-w-0 rounded-xl border border-cf-border bg-cf-panel/40 px-4 sm:px-5 py-4 space-y-3">
      <legend className="sr-only">{title}</legend>
      <div>
        <p className="text-sm font-semibold text-cf-text">
          {title}
          {optional && <span className="ml-2 text-xs font-normal text-cf-muted">{t('questionnaire.optional')}</span>}
        </p>
        <p className="text-xs text-cf-muted">{desc}</p>
      </div>
      <div className={`grid grid-cols-1 ${columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-3`}>{children}</div>
    </fieldset>
  );
};

const NumberField: React.FC<{
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: MessageKey;
  optional?: boolean;
}> = ({ id, label, unit, value, onChange, placeholder, hint, error, optional }) => {
  const { t } = useLanguage();
  return (
    <div className="space-y-1.5 min-w-0">
      <label htmlFor={id} className="text-sm font-medium text-cf-muted">
        {label}
        {optional && <span className="ml-1.5 font-normal text-cf-muted">{t('questionnaire.optional')}</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className={inputCls}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-cf-muted">{unit}</span>
      </div>
      {error ? <p className="text-xs text-red-800">{t(error)}</p> : hint && <p className="text-xs text-cf-muted">{hint}</p>}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; detail?: string; tag?: string; strong?: boolean }> = ({
  label,
  value,
  detail,
  tag,
  strong,
}) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5">
    <dt className={`min-w-0 ${strong ? 'font-semibold text-cf-text' : 'text-cf-muted'}`}>
      {label}
      {detail && <span className="ml-2 text-xs text-cf-muted">{detail}</span>}
      {tag && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full border border-cf-primary/40 bg-cf-hero/10 text-[0.7rem] text-cf-primary">{tag}</span>
      )}
    </dt>
    <dd className={`shrink-0 ${strong ? 'font-semibold text-cf-text' : 'text-cf-text'}`}>{value} €</dd>
  </div>
);
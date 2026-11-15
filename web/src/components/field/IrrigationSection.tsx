import React from 'react';
import { Calculator, Info } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import {
  IRRIGATION_LIMITS,
  IRRIGATION_METHODS,
  PUMP_POWERS,
  WATER_SOURCES,
  irrigationCost,
  type IrrigationBaseline,
  type IrrigationField,
  type IrrigationInput,
  type IrrigationMethod,
  type IrrigationParams,
  type IrrigationResult,
  type PumpPower,
  type SeasonIrrigationRecord,
  type WaterSource,
} from '../../lib/irrigation';
import { STREMMA_PER_HA, perStremmaEur, type Season } from '../../lib/seasons';
import { parseNum } from './FertilizerSection';

// The Irrigation step of a season (Άρδευση): where the water came from, how it was applied, how
// much was used and what it cost. Every figure is optional: what the farmer does not give is
// estimated with the same rules as the database (water from the crop's usual need and the
// season's irrigation answer; energy from the physics of lifting that water). Bills, kWh, litres
// and m³ are asked for this field's season as a whole; fees and consumables per stremma

export interface IrrigationDraft {
  // null: not filled in, the estimate uses the field's defaults
  source: WaterSource | null;
  power: PumpPower;
  method: IrrigationMethod | null;
  waterMode: 'm3' | 'hours';
  water: string; // m³, this field
  hours: string;
  flow: string; // m³/h
  energyMode: 'bill' | 'kwh';
  bill: string; // €, the meter's bills of the season
  kwh: string;
  shared: boolean;
  share: string; // %
  diesel: string; // litres for this field
  dieselPrice: string; // €/l
  fee: string; // € per stremma
  consumables: string; // € per stremma
}

const numText = (v: number | null, div = 1) => (v == null ? '' : String(Math.round((v / div) * 1000) / 1000));
const valid = (v: number | null): v is number => v !== null && !Number.isNaN(v);

export function irrigationDraftFrom(r: SeasonIrrigationRecord | null): IrrigationDraft {
  return {
    source: r?.source ?? null,
    power: r?.power ?? 'electric',
    method: r?.method ?? null,
    waterMode: r?.water_m3 == null && r?.pump_hours != null ? 'hours' : 'm3',
    water: numText(r?.water_m3 ?? null),
    hours: numText(r?.pump_hours ?? null),
    flow: numText(r?.pump_flow_m3h ?? null),
    energyMode: r?.electric_bill_eur == null && r?.electric_kwh != null ? 'kwh' : 'bill',
    bill: numText(r?.electric_bill_eur ?? null),
    kwh: numText(r?.electric_kwh ?? null),
    shared: r?.meter_share_pct != null,
    share: numText(r?.meter_share_pct ?? null),
    diesel: numText(r?.diesel_l ?? null),
    dieselPrice: numText(r?.diesel_price_eur_l ?? null),
    fee: numText(r?.network_fee_eur_ha ?? null, STREMMA_PER_HA),
    consumables: numText(r?.consumables_eur_ha ?? null, STREMMA_PER_HA),
  };
}

type Field = 'water' | 'hours' | 'flow' | 'bill' | 'kwh' | 'share' | 'diesel' | 'dieselPrice' | 'fee' | 'consumables';
export type IrrigationErrors = Partial<Record<Field, MessageKey>>;

const RANGE: Record<Field, { min: number; max: number; strictMin?: boolean; key: MessageKey }> = {
  water: { min: 0, max: IRRIGATION_LIMITS.waterM3, key: 'seasons.irrigation.invalid.water' },
  hours: { min: 0, max: IRRIGATION_LIMITS.hours, key: 'seasons.irrigation.invalid.hours' },
  flow: { min: 0, max: IRRIGATION_LIMITS.flow, strictMin: true, key: 'seasons.irrigation.invalid.flow' },
  bill: { min: 0, max: IRRIGATION_LIMITS.bill, key: 'seasons.irrigation.invalid.bill' },
  kwh: { min: 0, max: IRRIGATION_LIMITS.kwh, key: 'seasons.irrigation.invalid.kwh' },
  share: { min: 0, max: 100, strictMin: true, key: 'seasons.irrigation.invalid.share' },
  diesel: { min: 0, max: IRRIGATION_LIMITS.dieselL, key: 'seasons.irrigation.invalid.diesel' },
  dieselPrice: { min: 0, max: IRRIGATION_LIMITS.dieselPrice, key: 'seasons.irrigation.invalid.dieselPrice' },
  fee: { min: 0, max: IRRIGATION_LIMITS.feeStremma, key: 'seasons.irrigation.invalid.fee' },
  consumables: { min: 0, max: IRRIGATION_LIMITS.consumablesStremma, key: 'seasons.irrigation.invalid.consumables' },
};

// The fields that take part for the chosen source, power and modes
function activeFields(d: IrrigationDraft): Field[] {
  if (d.source === null || d.source === 'none') return [];
  const list: Field[] = d.waterMode === 'm3' ? ['water'] : ['hours', 'flow'];
  if (d.source === 'borehole' || d.source === 'surface') {
    if (d.power === 'electric') {
      list.push(d.energyMode === 'bill' ? 'bill' : 'kwh');
      if (d.shared) list.push('share');
    } else list.push('diesel', 'dieselPrice');
  }
  if (d.source === 'network') list.push('fee');
  list.push('consumables');
  return list;
}

export function validateIrrigation(d: IrrigationDraft): IrrigationErrors {
  const e: IrrigationErrors = {};
  const fields = activeFields(d);
  for (const f of fields) {
    const v = parseNum(d[f]);
    const r = RANGE[f];
    if (v !== null && (Number.isNaN(v) || v < r.min || (r.strictMin && v <= r.min) || v > r.max)) e[f] = r.key;
  }
  if (fields.includes('hours') && !e.hours && !e.flow && Boolean(d.hours.trim()) !== Boolean(d.flow.trim())) {
    e[d.hours.trim() ? 'flow' : 'hours'] = 'seasons.irrigation.invalid.hoursBoth';
  }
  return e;
}

// What save_season receives; null when nothing was filled in (the estimate then uses the field's defaults)
export function irrigationToInput(d: IrrigationDraft): IrrigationInput | null {
  if (d.source === null) return null;
  const on = new Set(activeFields(d));
  const n = (f: Field, mult = 1) => {
    if (!on.has(f)) return null;
    const v = parseNum(d[f]);
    return valid(v) ? Math.round(v * mult * 1000) / 1000 : null;
  };
  const pumped = d.source === 'borehole' || d.source === 'surface';
  return {
    source: d.source,
    power: pumped ? d.power : null,
    method: d.source === 'none' ? null : d.method,
    water_m3: n('water'),
    pump_hours: n('hours'),
    pump_flow_m3h: n('flow'),
    electric_bill_eur: n('bill'),
    electric_kwh: n('kwh'),
    meter_share_pct: n('share'),
    diesel_l: n('diesel'),
    diesel_price_eur_l: n('dieselPrice'),
    network_fee_eur_ha: n('fee', STREMMA_PER_HA),
    consumables_eur_ha: n('consumables', STREMMA_PER_HA),
  };
}

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg pl-3.5 pr-16 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors tabular-nums aria-[invalid=true]:border-red-400/60';

interface Props {
  draft: IrrigationDraft;
  onChange: (draft: IrrigationDraft) => void;
  season: Pick<Season, 'sown_on' | 'harvested_on' | 'irrigation' | 'crop_id'>;
  cropLabel: string;
  field: IrrigationField;
  params: IrrigationParams;
  baselines: Map<string, IrrigationBaseline>;
  showErrors: boolean;
}

export const IrrigationSection: React.FC<Props> = ({ draft, onChange, season, cropLabel, field, params, baselines, showErrors }) => {
  const { t, locale } = useLanguage();
  const errors = showErrors ? validateIrrigation(draft) : {};
  const set = (patch: Partial<IrrigationDraft>) => onChange({ ...draft, ...patch });
  const fmt = (v: number, max = 1) => v.toLocaleString(locale, { maximumFractionDigits: max });
  const money = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!season.crop_id) return <Notice text={t('seasons.irrigation.chooseCrop')} />;

  const baseline = baselines.get(season.crop_id);
  const usualMethod = baseline?.typical_method ?? null;
  const result: IrrigationResult = irrigationCost(season, irrigationToInput(draft), field, params, baselines);
  const pumped = draft.source === 'borehole' || draft.source === 'surface';
  const area = field.area_ha;
  const stremmata = area != null ? area * STREMMA_PER_HA : null;
  const perStremma = (v: number | null) => (v == null ? null : perStremmaEur(v));

  // The default text to display for the water source
  const defaultText =
    field.water_point_id != null && field.irrigation !== 'rainfed'
      ? t('seasons.irrigation.defaultBorehole')
      : t('seasons.irrigation.defaultNone');

  return (
    <div className="space-y-5">
      {/* Water source */}
      <div className="space-y-1.5">
        <p id="fs-irr-source" className="text-sm font-medium text-cf-muted">
          {t('seasons.irrigation.source')}
        </p>
        <div role="radiogroup" aria-labelledby="fs-irr-source" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {WATER_SOURCES.map((s) => (
            <Choice
              key={s}
              on={draft.source === s}
              title={t(`seasons.irrigation.sources.${s}`)}
              desc={t(`seasons.irrigation.sources.${s}Desc`)}
              onClick={() => set({ source: s })}
            />
          ))}
        </div>
        {draft.source === null && <p className="text-xs text-cf-muted">{defaultText}</p>}
      </div>

      {draft.source !== null && draft.source !== 'none' && (
        <>
          {/* Pump */}
          {pumped && (
            <div className="space-y-1.5">
              <p id="fs-irr-power" className="text-sm font-medium text-cf-muted">
                {t('seasons.irrigation.power')}
              </p>
              <div role="radiogroup" aria-labelledby="fs-irr-power" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {PUMP_POWERS.map((p) => (
                  <Choice
                    key={p}
                    on={draft.power === p}
                    title={t(`seasons.irrigation.powers.${p}`)}
                    desc={t(`seasons.irrigation.powers.${p}Desc`)}
                    onClick={() => set({ power: p })}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Method */}
          <div className="space-y-1.5">
            <p id="fs-irr-method" className="text-sm font-medium text-cf-muted">
              {t('seasons.irrigation.method')}
            </p>
            <div role="radiogroup" aria-labelledby="fs-irr-method" className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {IRRIGATION_METHODS.map((m) => (
                <Choice
                  key={m}
                  on={draft.method === m}
                  title={t(`seasons.irrigation.methods.${m}`)}
                  desc={t(`seasons.irrigation.methods.${m}Desc`)}
                  onClick={() => set({ method: draft.method === m ? null : m })}
                />
              ))}
            </div>
            {draft.method === null && usualMethod && (
              <p className="text-xs text-cf-muted">
                {t('seasons.irrigation.methodUsual', { method: t(`seasons.irrigation.methods.${usualMethod}`), crop: cropLabel })}
              </p>
            )}
          </div>

          {/* Water used */}
          <Group title={t('seasons.irrigation.water')} desc={t('seasons.irrigation.waterDesc')}>
            <Toggle
              value={draft.waterMode}
              options={[
                ['m3', t('seasons.irrigation.waterModeM3')],
                ['hours', t('seasons.irrigation.waterModeHours')],
              ]}
              onChange={(v) => set({ waterMode: v as 'm3' | 'hours' })}
            />
            {draft.waterMode === 'm3' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <NumberField
                  id="fs-irr-water"
                  label={t('seasons.irrigation.waterM3')}
                  unit="m³"
                  value={draft.water}
                  onChange={(v) => set({ water: v })}
                  placeholder={t('seasons.irrigation.waterPlaceholder')}
                  hint={perM3Hint(draft.water, stremmata, fmt, t)}
                  error={errors.water}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <NumberField
                  id="fs-irr-hours"
                  label={t('seasons.irrigation.hours')}
                  unit="h"
                  value={draft.hours}
                  onChange={(v) => set({ hours: v })}
                  placeholder={t('seasons.irrigation.hoursPlaceholder')}
                  error={errors.hours}
                />
                <NumberField
                  id="fs-irr-flow"
                  label={t('seasons.irrigation.flow')}
                  unit="m³/h"
                  value={draft.flow}
                  onChange={(v) => set({ flow: v })}
                  placeholder={t('seasons.irrigation.flowPlaceholder')}
                  hint={t('seasons.irrigation.flowHint')}
                  error={errors.flow}
                />
              </div>
            )}
          </Group>

          {/* Energy, fee */}
          {pumped && draft.power === 'electric' && (
            <Group title={t('seasons.irrigation.electricity')} desc={t('seasons.irrigation.electricityDesc')}>
              <Toggle
                value={draft.energyMode}
                options={[
                  ['bill', t('seasons.irrigation.energyModeBill')],
                  ['kwh', t('seasons.irrigation.energyModeKwh')],
                ]}
                onChange={(v) => set({ energyMode: v as 'bill' | 'kwh' })}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {draft.energyMode === 'bill' ? (
                  <NumberField
                    id="fs-irr-bill"
                    label={t('seasons.irrigation.bill')}
                    unit="€"
                    value={draft.bill}
                    onChange={(v) => set({ bill: v })}
                    placeholder={t('seasons.irrigation.billPlaceholder')}
                    error={errors.bill}
                  />
                ) : (
                  <NumberField
                    id="fs-irr-kwh"
                    label={t('seasons.irrigation.kwh')}
                    unit="kWh"
                    value={draft.kwh}
                    onChange={(v) => set({ kwh: v })}
                    placeholder={t('seasons.irrigation.kwhPlaceholder')}
                    hint={t('seasons.irrigation.kwhHint', { price: fmt(params.electricity_eur_kwh, 3) })}
                    error={errors.kwh}
                  />
                )}
                {draft.shared && (
                  <NumberField
                    id="fs-irr-share"
                    label={t('seasons.irrigation.share')}
                    unit="%"
                    value={draft.share}
                    onChange={(v) => set({ share: v })}
                    placeholder="50"
                    hint={t('seasons.irrigation.shareHint')}
                    error={errors.share}
                  />
                )}
              </div>
              <label className="flex items-center gap-2.5 text-sm text-cf-muted cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={draft.shared}
                  onChange={(e) => set({ shared: e.target.checked, share: e.target.checked ? draft.share : '' })}
                  className="w-4 h-4 accent-[var(--color-sage)] cursor-pointer"
                />
                {t('seasons.irrigation.shared')}
              </label>
            </Group>
          )}

          {pumped && draft.power === 'diesel' && (
            <Group title={t('seasons.irrigation.dieselTitle')} desc={t('seasons.irrigation.dieselDesc')}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <NumberField
                  id="fs-irr-diesel"
                  label={t('seasons.irrigation.diesel')}
                  unit="l"
                  value={draft.diesel}
                  onChange={(v) => set({ diesel: v })}
                  placeholder={t('seasons.irrigation.dieselPlaceholder')}
                  error={errors.diesel}
                />
                <NumberField
                  id="fs-irr-diesel-price"
                  label={t('seasons.irrigation.dieselPrice')}
                  unit="€/l"
                  value={draft.dieselPrice}
                  onChange={(v) => set({ dieselPrice: v })}
                  placeholder={fmt(params.diesel_eur_l, 2)}
                  hint={t('seasons.irrigation.dieselPriceHint', { price: fmt(params.diesel_eur_l, 2) })}
                  error={errors.dieselPrice}
                />
              </div>
            </Group>
          )}

          {draft.source === 'network' && (
            <Group title={t('seasons.irrigation.network')} desc={t('seasons.irrigation.networkDesc')}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <NumberField
                  id="fs-irr-fee"
                  label={t('seasons.irrigation.fee')}
                  unit={t('seasons.income.unitEurStremma')}
                  value={draft.fee}
                  onChange={(v) => set({ fee: v })}
                  placeholder={t('seasons.irrigation.feePlaceholder')}
                  error={errors.fee}
                />
              </div>
            </Group>
          )}

          <Group title={t('seasons.irrigation.consumablesTitle')} desc={t('seasons.irrigation.consumablesDesc')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <NumberField
                id="fs-irr-consumables"
                label={t('seasons.irrigation.consumables')}
                unit={t('seasons.income.unitEurStremma')}
                value={draft.consumables}
                onChange={(v) => set({ consumables: v })}
                placeholder="0"
                error={errors.consumables}
              />
            </div>
          </Group>
        </>
      )}

      {/* Result */}
      <ResultCard
        result={result}
        season={season}
        cropLabel={cropLabel}
        field={field}
        params={params}
        baseline={baseline}
        stremmata={stremmata}
        fmt={fmt}
        money={money}
        perStremma={perStremma}
      />
    </div>
  );
};

function perM3Hint(
  water: string,
  stremmata: number | null,
  fmt: (v: number, max?: number) => string,
  t: ReturnType<typeof useLanguage>['t'],
): string | undefined {
  const v = parseNum(water);
  if (!valid(v) || stremmata == null || stremmata <= 0) return t('seasons.irrigation.waterHint');
  return t('seasons.irrigation.waterPerStremma', { value: fmt(v / stremmata, 1) });
}

const ResultCard: React.FC<{
  result: IrrigationResult;
  season: Pick<Season, 'sown_on' | 'harvested_on' | 'irrigation' | 'crop_id'>;
  cropLabel: string;
  field: IrrigationField;
  params: IrrigationParams;
  baseline: IrrigationBaseline | undefined;
  stremmata: number | null;
  fmt: (v: number, max?: number) => string;
  money: (v: number) => string;
  perStremma: (v: number | null) => number | null;
}> = ({ result: r, cropLabel, field, params, baseline, stremmata, fmt, money, perStremma }) => {
  const { t } = useLanguage();
  const estimatedTag = t('seasons.income.estimated');

  const noteKey: MessageKey | null =
    r.basis === 'not_irrigated'
      ? 'seasons.irrigation.basis.not_irrigated'
      : r.basis === 'ongoing'
        ? 'seasons.irrigation.basis.ongoing'
        : r.basis === 'unknown_source'
          ? 'seasons.irrigation.basis.unknown_source'
          : null;

  const liftText =
    r.liftBasis === 'pump_depth'
      ? t('seasons.irrigation.liftPump', { value: fmt(r.liftM ?? 0, 1) })
      : r.liftBasis === 'borehole_depth'
        ? t('seasons.irrigation.liftBorehole', { value: fmt(r.liftM ?? 0, 1) })
        : r.liftBasis === 'default'
          ? t('seasons.irrigation.liftSurface', { value: fmt(r.liftM ?? 0, 1) })
          : null;

  return (
    <section className="rounded-xl border border-cf-border bg-cf-panel px-4 sm:px-5 py-4 space-y-3" aria-labelledby="fs-irr-result">
      <h4 id="fs-irr-result" className="text-sm font-semibold text-cf-text flex items-center gap-2">
        <Calculator className="w-4 h-4 text-cf-primary" aria-hidden="true" />
        {t('seasons.irrigation.resultTitle')}
      </h4>

      {noteKey ? (
        <p className="text-sm text-cf-muted">{t(noteKey)}</p>
      ) : (
        <>
          <dl className="text-sm divide-y divide-cf-border/60 tabular-nums">
            {r.waterHa != null && (
              <Row
                label={t('seasons.irrigation.rowWater')}
                detail={
                  r.waterBasis === 'estimated' && baseline
                    ? t('seasons.irrigation.waterEstimated', { mm: fmt(baseline.full_mm, 0), level: fmt(r.level, 2), crop: cropLabel })
                    : undefined
                }
                value={t('seasons.irrigation.m3Stremma', { value: fmt(r.waterHa / STREMMA_PER_HA, 1) })}
                tag={r.waterBasis === 'estimated' ? estimatedTag : undefined}
              />
            )}
            {r.headM != null && (
              <Row
                label={t('seasons.irrigation.rowHead')}
                detail={t('seasons.irrigation.headDetail', {
                  lift: liftText ?? '–',
                  pressure: fmt(r.pressureM ?? 0, 0),
                  method: r.method ? t(`seasons.irrigation.methods.${r.method}`) : '–',
                })}
                value={t('seasons.irrigation.metres', { value: fmt(r.headM, 1) })}
              />
            )}
            {r.energyLine && (
              <Row
                label={t(r.power === 'diesel' ? 'seasons.irrigation.rowDiesel' : 'seasons.irrigation.rowElectricity')}
                detail={
                  r.kwhHa != null
                    ? t('seasons.irrigation.kwhDetail', { value: fmt(r.kwhHa / STREMMA_PER_HA, 1), price: fmt(r.unitPrice ?? 0, 3) })
                    : r.litresHa != null
                      ? t('seasons.irrigation.litresDetail', { value: fmt(r.litresHa / STREMMA_PER_HA, 2), price: fmt(r.unitPrice ?? 0, 2) })
                      : r.energyBasis === 'reported'
                        ? t('seasons.irrigation.fromBill')
                        : undefined
                }
                value={r.energyEurHa != null ? `${money(perStremma(r.energyEurHa)!)} €` : t('seasons.irrigation.unknown')}
                tag={r.energyBasis === 'estimated' ? estimatedTag : undefined}
              />
            )}
            {r.networkLine && (
              <Row
                label={t('seasons.irrigation.rowNetwork')}
                value={r.networkEurHa != null ? `${money(perStremma(r.networkEurHa)!)} €` : t('seasons.irrigation.unknown')}
              />
            )}
            {r.consumablesLine && r.consumablesEurHa != null && (
              <Row label={t('seasons.irrigation.rowConsumables')} value={`${money(perStremma(r.consumablesEurHa)!)} €`} />
            )}
            {r.totalEurHa != null && (
              <Row label={t('seasons.irrigation.rowTotal')} value={`${money(perStremma(r.totalEurHa)!)} €`} strong />
            )}
          </dl>

          {r.totalEurHa != null && stremmata != null && (
            <p className="text-sm text-cf-primary tabular-nums">
              {t('seasons.irrigation.forField', { value: fmt(perStremma(r.totalEurHa)! * stremmata, 0) })}
              {r.waterHa != null && r.waterHa > 0 && (
                <span className="text-cf-muted">
                  {' '}
                  · {t('seasons.irrigation.waterField', { value: fmt((r.waterHa / STREMMA_PER_HA) * stremmata, 0) })}
                </span>
              )}
            </p>
          )}

          {/* What is missing for a figure */}
          {r.energyBasis === 'unknown' && r.source === 'borehole' && (
            <p className="text-xs text-cf-primary leading-relaxed">{t('seasons.irrigation.needDepth')}</p>
          )}
          {r.energyBasis === 'unknown' && r.source !== 'borehole' && r.method === null && (
            <p className="text-xs text-cf-primary leading-relaxed">{t('seasons.irrigation.needMethod')}</p>
          )}
          {r.networkLine && r.networkEurHa == null && (
            <p className="text-xs text-cf-primary leading-relaxed">{t('seasons.irrigation.needFee')}</p>
          )}
          {r.liftBasis === 'borehole_depth' && r.energyBasis === 'estimated' && (
            <p className="text-xs text-cf-muted leading-relaxed">{t('seasons.irrigation.upperBound')}</p>
          )}
          {r.energyBasis === 'estimated' && (
            <p className="text-xs text-cf-muted leading-relaxed">
              {t(r.power === 'diesel' ? 'seasons.irrigation.formulaDiesel' : 'seasons.irrigation.formulaElectric', {
                eff: fmt(r.power === 'diesel' ? params.pump_efficiency_diesel : params.pump_efficiency_electric, 2),
                kwhl: fmt(params.diesel_kwh_per_l, 1),
              })}
            </p>
          )}
          {field.irrigation === 'rainfed' && r.waterBasis === 'estimated' && r.level === 0 && (
            <p className="text-xs text-cf-muted">{t('seasons.irrigation.rainfedField')}</p>
          )}
        </>
      )}
    </section>
  );
};

const Notice: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-xl border border-dashed border-cf-border px-5 py-6 flex gap-3 text-sm text-cf-muted">
    <Info className="w-5 h-5 text-cf-muted shrink-0" aria-hidden="true" />
    <p className="leading-relaxed">{text}</p>
  </div>
);

const Choice: React.FC<{ on: boolean; title: string; desc: string; onClick: () => void }> = ({ on, title, desc, onClick }) => (
  <button
    type="button"
    role="radio"
    aria-checked={on}
    onClick={onClick}
    className={`text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
      on ? 'border-cf-primary/60 bg-cf-hero/15' : 'border-cf-border bg-cf-panel hover:border-cf-border-strong'
    }`}
  >
    <span className={`block text-sm font-medium ${on ? 'text-cf-text' : 'text-cf-muted'}`}>{title}</span>
    <span className="block text-xs text-cf-muted">{desc}</span>
  </button>
);

const Toggle: React.FC<{ value: string; options: [string, string][]; onChange: (v: string) => void }> = ({ value, options, onChange }) => (
  <div className="inline-flex rounded-lg border border-cf-border bg-cf-panel p-0.5 text-sm" role="radiogroup">
    {options.map(([v, label]) => (
      <button
        key={v}
        type="button"
        role="radio"
        aria-checked={value === v}
        onClick={() => onChange(v)}
        className={`px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
          value === v ? 'bg-cf-panel text-cf-text border border-cf-border' : 'text-cf-muted hover:text-cf-text border border-transparent'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
);

const Group: React.FC<{ title: string; desc: string; children: React.ReactNode }> = ({ title, desc, children }) => {
  const { t } = useLanguage();
  return (
    <fieldset className="min-w-0 rounded-xl border border-cf-border bg-cf-panel/40 px-4 sm:px-5 py-4 space-y-3">
      <legend className="sr-only">{title}</legend>
      <div>
        <p className="text-sm font-semibold text-cf-text">
          {title}
          <span className="ml-2 text-xs font-normal text-cf-muted">{t('questionnaire.optional')}</span>
        </p>
        <p className="text-xs text-cf-muted">{desc}</p>
      </div>
      {children}
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
}> = ({ id, label, unit, value, onChange, placeholder, hint, error }) => {
  const { t } = useLanguage();
  return (
    <div className="space-y-1.5 min-w-0">
      <label htmlFor={id} className="text-sm font-medium text-cf-muted">
        {label}
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
      {detail && <span className="block sm:inline sm:ml-2 text-xs text-cf-muted">{detail}</span>}
      {tag && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full border border-cf-primary/40 bg-cf-hero/10 text-[0.7rem] text-cf-primary">{tag}</span>
      )}
    </dt>
    <dd className={`shrink-0 ${strong ? 'font-semibold text-cf-text' : 'text-cf-text'}`}>{value}</dd>
  </div>
);
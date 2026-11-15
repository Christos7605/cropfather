import React, { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';
import { cropName, listCrops, type Crop } from '../../lib/seasons';
import {
  PREDICTION_KINDS,
  type PredictionOption,
  type PredictionResults,
} from '../../lib/prediction';

const CHOICE_KEY = {
  environment: 'environmental',
  financial: 'economic',
  current: 'current',
  balanced: 'mixed',
} as const;

const OPTION_ORDER = ['mix', 'economic', 'environmental', 'current'];

const SCORE_KEYS = [
  'overall',
  'economic',
  'environmental',
  'practical',
  'expected_yield_of_potential',
  'risk',
] as const;

const MONEY_KEYS = [
  'yield_kg_ha',
  'price_eur_kg',
  'revenue_eur_ha',
  'fertiliser_eur_ha',
  'water_cost_eur_ha',
  'costs_eur_ha',
  'margin_eur_ha',
  'subsidy_eur_ha_not_included',
] as const;

const WATER_KEYS = ['etc_mm', 'eff_rain_mm', 'net_mm', 'gross_m3_ha', 'cost_eur_ha'] as const;

const INPUT_KEYS = [
  'ece',
  'salinity_answer',
  'salinity_model',
  'ph',
  'months',
  'coldest',
  'warmest',
  'rain_annual',
  'clay',
  'drainage',
  'frost',
  'stony',
  'water_shortage',
  'risk_attitude',
  'priorities',
  'machinery',
  'labour',
  'soil_test',
] as const;

function roleKey(type: string): MessageKey | null {
  if (type === 'mix') return 'prediction.kind.balanced';
  if (type === 'economic') return 'prediction.kind.financial';
  if (type === 'environmental') return 'prediction.kind.environment';
  if (type === 'current') return 'prediction.kind.current';
  return null;
}

function ordered(options: PredictionOption[]): PredictionOption[] {
  const rank = (type: string) => {
    const index = OPTION_ORDER.indexOf(type);
    return index === -1 ? OPTION_ORDER.length : index;
  };
  return [...options].sort((a, b) => rank(a.type) - rank(b.type));
}

function figures(option: PredictionOption): string {
  return JSON.stringify({
    scores: option.scores_pct ?? null,
    economics: option.economics_eur_ha ?? null,
    water: option.water ?? null,
    nitrogen: option.nitrogen_kg_ha ?? null,
    comments: option.comments ?? null,
    warnings: option.warnings ?? null,
  });
}

function percent(value: string): string {
  return value ? `${value}%` : '';
}

function num(value: number, locale: string, digits: number): string {
  return value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function say(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  key: string,
  vars?: Record<string, string | number>,
): string {
  return t(key as MessageKey, vars);
}

export const PredictionResultsView: React.FC<{ results: PredictionResults | null }> = ({ results }) => {
  const { t, locale } = useLanguage();
  const [crops, setCrops] = useState<Crop[]>([]);

  useEffect(() => {
    let cancelled = false;
    listCrops()
      .then((rows) => {
        if (!cancelled) setCrops(rows);
      })
      .catch(() => {
        if (!cancelled) setCrops([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cropById = useMemo(() => new Map(crops.map((crop) => [crop.id, crop])), [crops]);
  const label = (id: string | null | undefined) => {
    if (!id) return t('prediction.noCrop');
    return cropName(cropById.get(id), locale.startsWith('el') ? 'el' : 'en', id);
  };

  const amount = (value: unknown, digits = 0): string => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '';
    return num(value, locale, digits);
  };

  const withUnit = (key: string, value: unknown): string => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '';
    if (key === 'price_eur_kg')     return say(t, 'prediction.detail.eurKg', { value: num(value, locale, 2) });
    if (key.endsWith('_eur_ha') || key === 'subsidy_eur_ha_not_included' || key === 'cost_eur_ha') {
      return say(t, 'prediction.detail.eurHa', { value: num(value, locale, key === 'cost_eur_ha' ? 2 : 0) });
    }
    if (key.endsWith('_kg_ha') || key === 'nitrogen_kg_ha') return say(t, 'prediction.detail.kgHa', { value: num(value, locale, 0) });
    if (key.endsWith('_mm')) return say(t, 'prediction.detail.mm', { value: num(value, locale, 1) });
    if (key.endsWith('_m3_ha')) return say(t, 'prediction.detail.m3', { value: num(value, locale, 0) });
    if (key.endsWith('_pct') || SCORE_KEYS.includes(key as (typeof SCORE_KEYS)[number])) {
      return say(t, 'prediction.detail.pct', { value: num(value, locale, 1) });
    }
    return num(value, locale, 1);
  };

  const options = ordered((results?.options ?? []).filter((option) => option && typeof option.type === 'string'));
  if (!options.length) {
    return (
      <ul className="bg-cf-panel border border-cf-primary/18 rounded-2xl divide-y divide-cf-primary/10">
        {PREDICTION_KINDS.map((kind) => (
          <li key={kind} className="px-5 py-4 space-y-1">
            <h2 className="text-sm font-medium text-cf-muted">{t(`prediction.kind.${kind}`)}</h2>
            <p className="text-base font-semibold text-cf-text">{label(results?.[CHOICE_KEY[kind]])}</p>
          </li>
        ))}
      </ul>
    );
  }

  const [lead, ...rest] = options;
  const leadFigures = lead ? figures(lead) : '';

  return (
    <div className="space-y-6">
      <Context results={results} />
      {lead && (
        <article className="bg-cf-hero rounded-2xl p-5 sm:p-8 space-y-5">
                <OptionBody option={lead} lead label={label} withUnit={withUnit} />
        </article>
      )}
      {rest.length > 0 && (
        <section className="bg-cf-panel border border-cf-primary/18 rounded-2xl" aria-label={t('prediction.detail.alternatives')}>
          <h2 className="px-5 pt-5 text-base font-semibold text-cf-text">{t('prediction.detail.alternatives')}</h2>
          <ul className="divide-y divide-cf-primary/10">
            {rest.map((option) => (
              <li key={option.type} className="px-5 py-5">
                <OptionBody
                  option={option}
                  label={label}
                  withUnit={withUnit}
                  compact={figures(option) === leadFigures}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Ranking results={results} label={label} amount={amount} />
      <Removed results={results} label={label} />
      <Inputs results={results} amount={amount} />
      <Weights results={results} amount={amount} />
      <Notes notes={results?.notes} />
    </div>
  );
};

const Context: React.FC<{ results: PredictionResults | null }> = ({ results }) => {
  const { t, locale } = useLanguage();
  const field = results?.field;
  const season = field?.coming_season === 'winter' || field?.coming_season === 'summer'
    ? say(t, `prediction.detail.${field.coming_season}`)
    : field?.coming_season || '';
  const date = field?.run_date ? formatDay(field.run_date, locale) : '';
  const confidence = typeof results?.confidence_pct === 'number'
    ? t('prediction.detail.confidence', { value: results.confidence_pct.toLocaleString(locale, { maximumFractionDigits: 1 }) })
    : '';
  const climate = [field?.climate_window, field?.climate_years].filter((part) => part != null && part !== '').join(' · ');
  const parts = [season, date, confidence, climate].filter(Boolean);
  if (!parts.length) return null;
  return <p className="text-sm text-cf-muted leading-relaxed">{parts.join(' · ')}</p>;
};

const OptionBody: React.FC<{
  option: PredictionOption;
  lead?: boolean;
  compact?: boolean;
  label: (id: string | null | undefined) => string;
  withUnit: (key: string, value: unknown) => string;
}> = ({ option, lead = false, compact = false, label, withUnit }) => {
  const { t } = useLanguage();
  const role = roleKey(option.type);
  const scores = option.scores_pct ?? {};
  const money = option.economics_eur_ha ?? {};
  const water = option.water ?? {};
  const also = (option.also_best_for ?? [])
    .map((type) => roleKey(type))
    .filter((key): key is MessageKey => Boolean(key))
    .map((key) => t(key));
  const scoreRows = metricRows(scores, SCORE_KEYS, t, 'prediction.detail.score', withUnit);
  const moneyRows = metricRows(money, MONEY_KEYS, t, 'prediction.detail.moneyKey', withUnit);
  const waterRows = metricRows(water, WATER_KEYS, t, 'prediction.detail.waterKey', withUnit);
  const source = money.source === 'farmer'
    ? t('prediction.detail.sourceFarmer')
    : money.source === 'estimate'
      ? t('prediction.detail.sourceEstimate')
      : typeof money.source === 'string'
        ? money.source
        : '';
  const nitrogen = withUnit('nitrogen_kg_ha', option.nitrogen_kg_ha);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className={`text-sm font-medium ${lead ? 'text-cf-primary' : 'text-cf-muted'}`}>
          {role ? t(role) : option.type}
        </p>
        <h3 className={`${lead ? 'text-2xl sm:text-3xl' : 'text-xl'} font-semibold text-cf-text`}>{label(option.crop)}</h3>
        {option.why && <p className="text-sm text-cf-text leading-relaxed max-w-2xl">{option.why}</p>}
        {option.comment && <p className="text-sm text-cf-text leading-relaxed max-w-2xl">{option.comment}</p>}
        {also.length > 0 && (
          <p className="text-sm text-cf-muted leading-relaxed">
            {t('prediction.detail.also', { roles: also.join(', ') })}
          </p>
        )}
      </div>
      {compact ? (
        <p className="text-sm text-cf-muted leading-relaxed">{t('prediction.detail.sameAsLead')}</p>
      ) : (
        <>
          <MetricBlock title={t('prediction.detail.scores')} rows={scoreRows} />
          <MetricBlock title={t('prediction.detail.money')} rows={moneyRows} note={source} />
          <MetricBlock title={t('prediction.detail.water')} rows={waterRows} />
          {nitrogen && (
            <p className="text-sm text-cf-text">
              <span className="text-cf-muted">{t('prediction.detail.nitrogen')} </span>
              {nitrogen}
            </p>
          )}
          <Lines title={t('prediction.detail.warnings')} lines={option.warnings ?? []} />
          <Lines title={t('prediction.detail.comments')} lines={option.comments ?? []} />
          {(option.warnings?.length || option.comments?.length) ? (
            <p className="text-xs text-cf-muted leading-relaxed">{t('prediction.detail.modelLanguage')}</p>
          ) : null}
        </>
      )}
    </div>
  );
};

function metricRows(
  source: Record<string, unknown>,
  keys: readonly string[],
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  prefix: string,
  withUnit: (key: string, value: unknown) => string,
): { label: string; value: string }[] {
  const known = new Set<string>(keys);
  const extra = Object.keys(source).filter((key) => !known.has(key) && key !== 'source');
  return [...keys, ...extra].map((key) => ({
    label: known.has(key) ? say(t, `${prefix}.${key}`) : key,
    value: withUnit(key, source[key]),
  }));
}

const MetricBlock: React.FC<{ title: string; rows: { label: string; value: string }[]; note?: string }> = ({
  title,
  rows,
  note,
}) => {
  const visible = rows.filter((row) => row.value);
  if (!visible.length) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-cf-text">{title}</h4>
      {note && <p className="text-xs text-cf-muted">{note}</p>}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
        {visible.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-cf-muted">{row.label}</dt>
            <dd className="text-sm font-medium text-cf-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

const Lines: React.FC<{ title: string; lines: string[] }> = ({ title, lines }) => {
  if (!lines.length) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium text-cf-text">{title}</h4>
      <ul className="space-y-1">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`} className="text-sm text-cf-text leading-relaxed">{line}</li>
        ))}
      </ul>
    </div>
  );
};

const Ranking: React.FC<{
  results: PredictionResults | null;
  label: (id: string | null | undefined) => string;
  amount: (value: unknown, digits?: number) => string;
}> = ({ results, label, amount }) => {
  const { t } = useLanguage();
  const rows = results?.ranking ?? [];
  if (!rows.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="prediction-ranking">
      <h2 id="prediction-ranking" className="text-base font-semibold text-cf-text">{t('prediction.detail.ranking')}</h2>
      <div className="overflow-x-auto bg-cf-panel border border-cf-primary/18 rounded-2xl">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="text-xs text-cf-muted">
              <th className="px-4 py-3 font-medium">{t('prediction.detail.crop')}</th>
              <th className="px-4 py-3 font-medium">{t('prediction.detail.score.overall')}</th>
              <th className="px-4 py-3 font-medium">{t('prediction.detail.score.economic')}</th>
              <th className="px-4 py-3 font-medium">{t('prediction.detail.score.environmental')}</th>
              <th className="px-4 py-3 font-medium">{t('prediction.detail.moneyKey.margin_eur_ha')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.crop} className="border-t border-cf-primary/10">
                <th className="px-4 py-3 font-medium text-cf-text">{label(row.crop)}</th>
                <td className="px-4 py-3 text-cf-text">{percent(amount(row.overall_pct, 1))}</td>
                <td className="px-4 py-3 text-cf-text">{percent(amount(row.economic_pct, 1))}</td>
                <td className="px-4 py-3 text-cf-text">{percent(amount(row.environmental_pct, 1))}</td>
                <td className="px-4 py-3 text-cf-text">
                  {amount(row.margin_eur_ha, 0) ? t('prediction.detail.eurHa', { value: amount(row.margin_eur_ha, 0) }) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Removed: React.FC<{
  results: PredictionResults | null;
  label: (id: string | null | undefined) => string;
}> = ({ results, label }) => {
  const { t } = useLanguage();
  const removed = results?.removed_by_pruning ?? {};
  const names = Object.keys(removed);
  if (!names.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="prediction-removed">
      <h2 id="prediction-removed" className="text-base font-semibold text-cf-text">{t('prediction.detail.removed')}</h2>
      <ul className="bg-cf-panel border border-cf-primary/18 rounded-2xl divide-y divide-cf-primary/10">
        {names.map((name) => (
          <li key={name} className="px-5 py-4 space-y-1">
            <p className="text-sm font-medium text-cf-text">{label(name)}</p>
            {(removed[name] ?? []).map((reason, index) => (
              <p key={`${index}-${reason}`} className="text-sm text-cf-muted leading-relaxed">{reason}</p>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-xs text-cf-muted leading-relaxed">{t('prediction.detail.modelLanguage')}</p>
    </section>
  );
};

const Inputs: React.FC<{
  results: PredictionResults | null;
  amount: (value: unknown, digits?: number) => string;
}> = ({ results, amount }) => {
  const { t } = useLanguage();
  const inputs = results?.inputs ?? {};
  const keys = [...INPUT_KEYS.filter((key) => key in inputs), ...Object.keys(inputs).filter((key) => !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]))];
  if (!keys.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="prediction-inputs">
      <h2 id="prediction-inputs" className="text-base font-semibold text-cf-text">{t('prediction.detail.inputs')}</h2>
      <dl className="bg-cf-panel border border-cf-primary/18 rounded-2xl divide-y divide-cf-primary/10">
        {keys.map((key) => {
          const row = inputs[key];
          const source = row?.source && row.source !== 'missing' ? say(t, `prediction.detail.source.${row.source}`) : '';
          return (
            <div key={key} className="px-5 py-3 flex items-baseline justify-between gap-4">
              <dt className="text-sm text-cf-muted">{say(t, `prediction.detail.input.${key}`)}</dt>
              <dd className="text-sm font-medium text-cf-text text-right">
                {formatInput(key, row?.value, amount, t)}
                {row?.value != null && row.value !== '' ? inputUnit(key) : ''}
                {source ? <span className="block text-xs font-normal text-cf-muted">{source}</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
};

function inputUnit(key: string): string {
  if (key === 'ece' || key === 'salinity_answer') return ' dS/m';
  if (key === 'coldest' || key === 'warmest' || key === 'months') return ' °C';
  if (key === 'rain_annual') return ' mm';
  if (key === 'clay') return '%';
  return '';
}

function formatInput(
  key: string,
  value: unknown,
  amount: (value: unknown, digits?: number) => string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (value == null || value === '') return t('prediction.detail.missing');
  if (typeof value === 'boolean') return value ? t('prediction.detail.yes') : t('prediction.detail.no');
  if (typeof value === 'number') return amount(value, Number.isInteger(value) ? 0 : 1) || t('prediction.detail.missing');
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'number' ? amount(item, 1) : named(t, `${key === 'priorities' ? 'prediction.detail.priority' : key}.${item}`, String(item))))
      .filter(Boolean)
      .join(', ');
  }
  if (key === 'machinery') return named(t, `prediction.detail.machine.${value}`, String(value));
  if (key === 'labour') return named(t, `prediction.detail.labour.${value}`, String(value));
  return String(value);
}

function named(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
): string {
  const text = say(t, key);
  return text === key ? fallback : text;
}

const Weights: React.FC<{
  results: PredictionResults | null;
  amount: (value: unknown, digits?: number) => string;
}> = ({ results, amount }) => {
  const { t, locale } = useLanguage();
  const weights = results?.weights;
  if (!weights) return null;
  const rows = [
    ...Object.entries(weights.parts ?? {}).map(([key, value]) => ({
      label: say(t, `prediction.detail.weight.${key}`),
      value: amount(value, 1),
    })),
    ...Object.entries(weights.environment ?? {}).map(([key, value]) => ({
      label: say(t, `prediction.detail.envWeight.${key}`),
      value: amount(value, 1),
    })),
    { label: t('prediction.detail.weight.risk'), value: amount(weights.risk_weight, 2) },
    {
      label: t('prediction.detail.waterPrice'),
      value: typeof weights.water_price_eur_m3 === 'number'
        ? t('prediction.detail.eurM3', { value: weights.water_price_eur_m3.toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })
        : '',
    },
  ].filter((row) => row.value);
  if (!rows.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="prediction-weights">
      <h2 id="prediction-weights" className="text-base font-semibold text-cf-text">{t('prediction.detail.weights')}</h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 bg-cf-panel border border-cf-primary/18 rounded-2xl p-5">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-cf-muted">{row.label}</dt>
            <dd className="text-sm font-medium text-cf-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

const Notes: React.FC<{ notes: string[] | null | undefined }> = ({ notes }) => {
  const { t } = useLanguage();
  if (!notes?.length) return null;
  return (
    <section className="space-y-2" aria-labelledby="prediction-notes">
      <h2 id="prediction-notes" className="text-base font-semibold text-cf-text">{t('prediction.detail.notes')}</h2>
      <ul className="space-y-1">
        {notes.map((note, index) => (
          <li key={`${index}-${note}`} className="text-sm text-cf-muted leading-relaxed">{note}</li>
        ))}
      </ul>
      <p className="text-xs text-cf-muted leading-relaxed">{t('prediction.detail.modelLanguage')}</p>
    </section>
  );
};

function formatDay(iso: string, locale: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

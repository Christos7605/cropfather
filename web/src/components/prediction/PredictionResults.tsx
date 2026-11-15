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

function roleKey(type: string): MessageKey | null {
  if (type === 'mix') return 'prediction.kind.balanced';
  if (type === 'economic') return 'prediction.kind.financial';
  if (type === 'environmental') return 'prediction.kind.environment';
  if (type === 'current') return 'prediction.kind.current';
  return null;
}

function whyKey(type: string): MessageKey | null {
  if (type === 'mix' || type === 'economic' || type === 'environmental' || type === 'current') {
    return `prediction.detail.why.${type}`;
  }
  return null;
}

function ordered(options: PredictionOption[]): PredictionOption[] {
  const rank = (type: string) => {
    const index = OPTION_ORDER.indexOf(type);
    return index === -1 ? OPTION_ORDER.length : index;
  };
  return [...options].sort((a, b) => rank(a.type) - rank(b.type));
}

function num(value: number, locale: string, digits: number): string {
  return value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const PredictionResultsView: React.FC<{ results: PredictionResults | null }> = ({ results }) => {
  const { t, locale, language } = useLanguage();
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
    return cropName(cropById.get(id), language, id);
  };

  const options = ordered((results?.options ?? []).filter((option) => option && typeof option.type === 'string'));
  const season = results?.field?.coming_season === 'winter' || results?.field?.coming_season === 'summer'
    ? t(`prediction.detail.${results.field.coming_season}`)
    : '';
  const confidence = typeof results?.confidence_pct === 'number'
    ? t('prediction.detail.confidence', {
        value: results.confidence_pct.toLocaleString(locale, { maximumFractionDigits: 1 }),
      })
    : '';
  const context = [season, confidence].filter(Boolean).join(' · ');

  if (!options.length) {
    return (
      <ul className="cf-glass-box rounded-2xl divide-y divide-cf-primary/10">
        {PREDICTION_KINDS.map((kind) => (
          <li key={kind} className="px-5 py-4 sm:px-6 space-y-1">
            <h2 className="text-sm font-medium text-cf-muted">{t(`prediction.kind.${kind}`)}</h2>
            <p className="text-lg font-semibold text-cf-text">{label(results?.[CHOICE_KEY[kind]])}</p>
          </li>
        ))}
      </ul>
    );
  }

  const [lead, ...rest] = options;

  return (
    <div className="space-y-4">
      {context && <p className="text-sm text-cf-muted leading-relaxed">{context}</p>}
      {lead && (
        <article className="cf-glass-box rounded-2xl p-3 sm:p-4">
          <div className="rounded-xl bg-cf-hero px-5 py-6 sm:px-8 sm:py-8 space-y-5">
            <div className="space-y-2 max-w-2xl">
              <p className="text-sm font-medium text-cf-primary">{t('prediction.detail.recommended')}</p>
              <h2 className="text-3xl sm:text-4xl font-semibold text-cf-text tracking-tight">{label(lead.crop)}</h2>
              <p className="text-sm text-cf-muted">{roleKey(lead.type) ? t(roleKey(lead.type) as MessageKey) : lead.type}</p>
              {whyKey(lead.type) && (
                <p className="text-sm sm:text-base text-cf-text leading-relaxed">{t(whyKey(lead.type) as MessageKey)}</p>
              )}
            </div>
            <Metrics option={lead} prominent />
          </div>
        </article>
      )}
      {rest.length > 0 && (
        <section className="cf-glass-box rounded-2xl" aria-label={t('prediction.detail.alternatives')}>
          <h2 className="px-5 pt-5 sm:px-6 text-base font-semibold text-cf-text">{t('prediction.detail.alternatives')}</h2>
          <ul className="divide-y divide-cf-primary/10">
            {rest.map((option) => {
              const role = roleKey(option.type);
              const why = whyKey(option.type);
              return (
                <li key={option.type} className="px-5 py-5 sm:px-6 space-y-3">
                  <div className="space-y-1 max-w-2xl">
                    <p className="text-sm font-medium text-cf-muted">{role ? t(role) : option.type}</p>
                    <h3 className="text-xl font-semibold text-cf-text">{label(option.crop)}</h3>
                    {why && <p className="text-sm text-cf-text leading-relaxed">{t(why)}</p>}
                  </div>
                  <Metrics option={option} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
};

const Metrics: React.FC<{ option: PredictionOption; prominent?: boolean }> = ({ option, prominent = false }) => {
  const { t, locale } = useLanguage();
  const scores = option.scores_pct ?? {};
  const money = option.economics_eur_ha ?? {};
  const water = option.water ?? {};
  const rows = [
    metric(t('prediction.detail.score.overall'), score(scores.overall, locale, t)),
    metric(t('prediction.detail.moneyKey.margin_eur_ha'), moneyValue(money.margin_eur_ha, locale, t)),
    metric(t('prediction.detail.waterKey.gross_m3_ha'), waterValue(water.gross_m3_ha, locale, t)),
    metric(t('prediction.detail.moneyKey.yield_kg_ha'), yieldValue(money.yield_kg_ha, locale, t)),
  ].filter((row) => row.value);
  if (!rows.length) return null;
  return (
    <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 ${prominent ? 'sm:grid-cols-4' : 'sm:grid-cols-4'}`}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs text-cf-muted">{row.label}</dt>
          <dd className={`${prominent ? 'text-base' : 'text-sm'} font-medium text-cf-text`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
};

function metric(label: string, value: string): { label: string; value: string } {
  return { label, value };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function score(
  value: unknown,
  locale: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const amount = asNumber(value);
  if (amount == null) return '';
  return t('prediction.detail.pct', { value: num(amount, locale, 1) });
}

function moneyValue(
  value: unknown,
  locale: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const amount = asNumber(value);
  if (amount == null) return '';
  return t('prediction.detail.eurHa', { value: num(amount, locale, 0) });
}

function waterValue(
  value: unknown,
  locale: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const amount = asNumber(value);
  if (amount == null) return '';
  return t('prediction.detail.m3', { value: num(amount, locale, 0) });
}

function yieldValue(
  value: unknown,
  locale: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const amount = asNumber(value);
  if (amount == null) return '';
  return t('prediction.detail.kgHa', { value: num(amount, locale, 0) });
}

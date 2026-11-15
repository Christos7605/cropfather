import React, { useEffect, useState } from 'react';
import { ChevronRight, Loader2, Sprout, TrendingDown, TrendingUp } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { listSeasonResults, type SeasonResult } from '../../lib/seasons';
import { cropColor } from './SeasonTimeline';
import { fullDate, periodLabel } from './periodLabel';

// Overview tab: the result of each season of the field (income minus recorded costs, per stremma),
// read from the database view season_finance, so it shows exactly what the database holds
// Bars compare seasons at a glance; the crop in the field now is shown on top

const SHOWN = 6;

export const SeasonResultsCard: React.FC<{
  fieldId: string;
  cropLabel: (cropId: string) => string;
  onOpenHistory: () => void;
}> = ({ fieldId, cropLabel, onOpenHistory }) => {
  const { t, locale } = useLanguage();
  const [rows, setRows] = useState<SeasonResult[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    listSeasonResults(fieldId)
      .then((list) => alive && setRows(list))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [fieldId]);

  const money = (v: number) => Math.abs(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (v: number) => `${v < 0 ? '−' : '+'}${money(v)}`;

  const current = rows?.find((r) => r.ongoing) ?? null;
  const finished = (rows ?? []).filter((r) => !r.ongoing);
  const shown = finished.slice(0, SHOWN);
  const withResult = finished.filter((r) => r.margin_eur_stremma !== null);
  const max = Math.max(1, ...shown.map((r) => Math.abs(r.margin_eur_stremma ?? 0)));
  const avg = withResult.length ? withResult.reduce((s, r) => s + r.margin_eur_stremma!, 0) / withResult.length : null;
  const profitable = withResult.filter((r) => r.margin_eur_stremma! > 0).length;

  return (
    <section className="cf-glass-box rounded-2xl p-5 sm:p-6 space-y-4" aria-labelledby="fs-results-title">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="fs-results-title" className="text-lg font-semibold text-cf-text">
            {t('field.results.title')}
          </h2>
          <p className="text-sm text-cf-muted leading-relaxed">{t('field.results.desc')}</p>
        </div>
        <button
          type="button"
          onClick={onOpenHistory}
          className="shrink-0 text-sm text-cf-primary hover:underline cursor-pointer inline-flex items-center gap-0.5"
        >
          {t('field.results.open')}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {rows === null && !failed && (
        <p className="py-4 text-sm text-cf-muted flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('common.loading')}
        </p>
      )}
      {failed && <p className="text-sm text-cf-muted">{t('field.results.failed')}</p>}

      {rows !== null && (
        <>
          {current && (
            <p className="text-sm text-cf-muted flex items-center gap-2 rounded-lg bg-cf-panel border border-cf-border px-3.5 py-2.5">
              <Sprout className="w-4 h-4 text-cf-primary shrink-0" aria-hidden="true" />
              <span>
                {t('field.results.now', {
                  crop: cropLabel(current.crop_id),
                  date: current.sown_on ? fullDate(current.sown_on, locale) : String(current.season_year),
                })}
              </span>
            </p>
          )}

          {shown.length === 0 ? (
            <p className="text-sm text-cf-muted">{rows.length === 0 ? t('field.results.none') : t('field.results.noneFinished')}</p>
          ) : (
            <ul className="space-y-3">
              {shown.map((r) => {
                const m = r.margin_eur_stremma;
                const estimated = r.revenue_basis !== 'reported' && r.revenue_basis !== 'no_harvest';
                return (
                  <li key={r.season_id} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <p className="min-w-0 truncate">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                          style={{ backgroundColor: cropColor(r.crop_id) }}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-cf-text">{cropLabel(r.crop_id)}</span>
                        <span className="text-cf-muted"> · {periodLabel(t, locale, r)}</span>
                      </p>
                      {m === null ? (
                        <span className="shrink-0 text-xs text-cf-muted">{t('field.results.noData')}</span>
                      ) : (
                        <span className={`shrink-0 tabular-nums font-semibold ${m >= 0 ? 'text-cf-primary' : 'text-red-900'}`}>
                          {t('field.results.value', { value: signed(m) })}
                          {estimated && <span className="ml-1.5 text-xs font-normal text-cf-muted">{t('seasons.income.estimated')}</span>}
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 rounded-full bg-cf-primary/20 overflow-hidden" aria-hidden="true">
                      {m !== null && (
                        <div
                          className={`h-full rounded-full ${m >= 0 ? 'bg-cf-hero/70' : 'bg-red-400/70'}`}
                          style={{ width: `${Math.max(2, (Math.abs(m) / max) * 100)}%` }}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {avg !== null && (
            <div className="pt-3 border-t border-cf-border/70 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
              <p className="flex items-center gap-2 text-cf-muted">
                {avg >= 0 ? <TrendingUp className="w-4 h-4 text-cf-primary" /> : <TrendingDown className="w-4 h-4 text-red-900" />}
                {t('field.results.avg', { count: String(withResult.length) })}
                <span className={`font-semibold tabular-nums ${avg >= 0 ? 'text-cf-primary' : 'text-red-900'}`}>
                  {t('field.results.value', { value: signed(avg) })}
                </span>
              </p>
              <p className="text-cf-muted tabular-nums">
                {t('field.results.profitable', { count: String(profitable), total: String(withResult.length) })}
              </p>
            </div>
          )}
          {withResult.length > 0 && <p className="text-xs text-cf-muted leading-relaxed">{t('field.results.note')}</p>}
        </>
      )}
    </section>
  );
};
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  Droplets,
  Loader2,
  Snowflake,
  Sun,
  Thermometer,
  Wind,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  HEAVY_RAIN_MM,
  STRONG_GUST_KMH,
  WEATHER_SOURCE_URL,
  alertsFor,
  fetchForecast,
  skyOf,
  waterBalance,
  type AlertKind,
  type Forecast,
  type Sky,
} from '../../lib/weather';
import { secondaryBtn } from '../questionnaire/QuestionnaireWizard';

// Weather at a field: the full forecast (Weather tab) or a short card (Overview tab)

const SKY_ICON: Record<Sky, React.ComponentType<{ className?: string }>> = {
  clear: Sun,
  partly: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  freezingRain: CloudRainWind,
  snow: CloudSnow,
  showers: CloudRain,
  thunder: CloudLightning,
  hail: CloudHail,
};
const SKY_TONE: Partial<Record<Sky, string>> = { clear: 'text-cf-primary', partly: 'text-cf-primary', thunder: 'text-red-800', hail: 'text-red-800' };

const ALERT_STYLE: Record<AlertKind, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  frost: { icon: Snowflake, tone: 'border-cf-primary/40 bg-cf-hero/10 text-cf-primary' },
  heat: { icon: Thermometer, tone: 'border-red-800/40 bg-red-50/10 text-red-800' },
  heavyRain: { icon: CloudRain, tone: 'border-cf-primary/40 bg-cf-hero/10 text-cf-primary' },
  wind: { icon: Wind, tone: 'border-cf-primary/40 bg-cf-hero/10 text-cf-primary' },
};

interface Props {
  lat: number | null;
  lon: number | null;
  irrigated: boolean;
  compact?: boolean;
  // Compact card only: opens the Weather tab
  onOpenFull?: () => void;
}

export const WeatherPanel: React.FC<Props> = ({ lat, lon, irrigated, compact = false, onOpenFull }) => {
  const { t, locale } = useLanguage();
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (lat == null || lon == null) {
        setState('error');
        return;
      }
      setState('loading');
      fetchForecast(lat, lon, signal)
        .then((f) => {
          setForecast(f);
          setState('ready');
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setState('error');
        });
    },
    [lat, lon],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const round = (v: number | null) => (v == null ? '–' : Math.round(v).toLocaleString(locale));
  const mm = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  const dayName = (iso: string, i: number) => {
    if (i === 0) return t('field.weather.today');
    if (i === 1) return t('field.weather.tomorrow');
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(`${iso}T12:00:00`));
  };
  const shortDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00`));
  const dayList = (dates: string[]) =>
    dates
      .map((d) => {
        const i = forecast?.days.findIndex((x) => x.date === d) ?? -1;
        return i >= 0 && i < 2 ? dayName(d, i) : `${dayName(d, i)} ${shortDate(d)}`;
      })
      .join(', ');

  const card = 'cf-glass-box rounded-2xl';

  if (state === 'loading') {
    return (
      <div className={`${card} p-5 sm:p-6`}>
        <p className="text-sm text-cf-muted flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('field.weather.loading')}
        </p>
      </div>
    );
  }

  if (state === 'error' || !forecast || forecast.days.length === 0) {
    return (
      <div className={`${card} p-5 sm:p-6 space-y-3`}>
        <h2 className="text-lg font-semibold text-cf-text">{t('field.weather.title')}</h2>
        <p className="text-sm text-cf-muted">{t('field.weather.unavailable')}</p>
        {lat != null && lon != null && (
          <button type="button" onClick={() => load()} className={secondaryBtn}>
            {t('field.weather.retry')}
          </button>
        )}
      </div>
    );
  }

  const { now, days } = forecast;
  const NowIcon = SKY_ICON[skyOf(now.code)];
  const alerts = alertsFor(days);
  const balance = waterBalance(days);
  const deficit = balance.et0 - balance.rain;

  const alertText = (kind: AlertKind, dates: string[]) =>
    t(`field.weather.alert.${kind}`, {
      days: dayList(dates),
      mm: String(HEAVY_RAIN_MM),
      kmh: String(STRONG_GUST_KMH),
    });

  const nowBlock = (
    <div className="flex items-center gap-4">
      <NowIcon className={`w-11 h-11 shrink-0 ${SKY_TONE[skyOf(now.code)] ?? 'text-cf-muted'}`} />
      <div className="min-w-0">
        <p className="text-3xl font-semibold text-cf-text tabular-nums leading-none">
          {round(now.temp)}°<span className="text-lg text-cf-muted">C</span>
        </p>
        <p className="text-sm text-cf-muted mt-1">{t(`field.weather.sky.${skyOf(now.code)}`)}</p>
      </div>
    </div>
  );

  const alertList = alerts.length > 0 && (
    <ul className="space-y-2">
      {alerts.map((a) => {
        const { icon: Icon, tone } = ALERT_STYLE[a.kind];
        return (
          <li key={a.kind} className={`rounded-lg border px-3 py-2 text-sm flex gap-2.5 ${tone}`}>
            <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="text-cf-muted leading-snug">{alertText(a.kind, a.dates)}</span>
          </li>
        );
      })}
    </ul>
  );

  if (compact) {
    return (
      <div className={`${card} p-5 sm:p-6 space-y-4`}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-cf-text">{t('field.weather.title')}</h2>
          {alerts.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cf-hero/15 border border-cf-primary/30 text-xs font-medium text-cf-primary">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              {alerts.length}
            </span>
          )}
        </div>
        {nowBlock}
        <ol className="grid grid-cols-3 gap-2">
          {days.slice(1, 4).map((d, i) => {
            const Icon = SKY_ICON[skyOf(d.code)];
            return (
              <li key={d.date} className="bg-cf-panel border border-cf-border rounded-lg px-2 py-2.5 text-center">
                <p className="text-xs text-cf-muted">{dayName(d.date, i + 1)}</p>
                <Icon className={`w-5 h-5 mx-auto my-1.5 ${SKY_TONE[skyOf(d.code)] ?? 'text-cf-muted'}`} aria-label={t(`field.weather.sky.${skyOf(d.code)}`)} />
                <p className="text-sm tabular-nums">
                  <span className="text-cf-text font-medium">{round(d.tMax)}°</span>{' '}
                  <span className="text-cf-muted">{round(d.tMin)}°</span>
                </p>
              </li>
            );
          })}
        </ol>
        {alertList}
        {onOpenFull && (
          <button type="button" onClick={onOpenFull} className={`${secondaryBtn} w-full`}>
            {t('field.weather.full')}
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        <a href={WEATHER_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="block text-xs text-cf-muted underline hover:text-cf-muted">
          {t('field.weather.credit')}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Now */}
      <div className={`${card} p-5 sm:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-5`}>
        <div className="space-y-3">
          <p className="text-sm font-medium text-cf-muted">{t('field.weather.now')}</p>
          {nowBlock}
        </div>
        <dl className="grid grid-cols-3 gap-2.5 md:min-w-[22rem]">
          {[
            { icon: Thermometer, label: t('field.weather.feelsLike'), value: `${round(now.feelsLike)}°` },
            { icon: Droplets, label: t('field.weather.humidity'), value: `${round(now.humidity)}%` },
            { icon: Wind, label: t('field.weather.wind'), value: t('field.weather.kmh', { value: round(now.wind) }) },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="bg-cf-panel border border-cf-border rounded-lg px-3 py-2.5 min-w-0">
              <dt className="text-xs text-cf-muted flex items-center gap-1.5 truncate">
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {label}
              </dt>
              <dd className="text-base font-semibold text-cf-text tabular-nums mt-0.5 truncate">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Watch out */}
      <div className={`${card} p-5 sm:p-6 space-y-3`}>
        <h2 className="text-lg font-semibold text-cf-text">{t('field.weather.watchTitle')}</h2>
        {alerts.length > 0 ? alertList : <p className="text-sm text-cf-muted">{t('field.weather.noAlerts')}</p>}
      </div>

      {/* Next 7 days */}
      <div className={`${card} overflow-hidden`}>
        <h2 className="px-5 sm:px-6 pt-5 pb-4 text-lg font-semibold text-cf-text">
          {t('field.weather.daysTitle', { count: String(days.length) })}
        </h2>
        <ol className="divide-y divide-cf-border border-t border-cf-border">
          {days.map((d, i) => {
            const sky = skyOf(d.code);
            const Icon = SKY_ICON[sky];
            const wet = (d.rainMm ?? 0) >= 0.1;
            return (
              <li
                key={d.date}
                className="px-5 sm:px-6 py-3 grid grid-cols-[5.5rem_2rem_minmax(0,1fr)_auto] sm:grid-cols-[7rem_2rem_minmax(0,1fr)_6rem_9rem_6rem] items-center gap-x-3 gap-y-1 text-sm"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-cf-text truncate">{dayName(d.date, i)}</span>
                  <span className="block text-xs text-cf-muted">{shortDate(d.date)}</span>
                </span>
                <Icon className={`w-6 h-6 ${SKY_TONE[sky] ?? 'text-cf-muted'}`} aria-hidden="true" />
                <span className="text-cf-muted truncate">{t(`field.weather.sky.${sky}`)}</span>
                <span className="text-right tabular-nums whitespace-nowrap">
                  <span className="text-cf-text font-semibold">{round(d.tMax)}°</span>
                  <span className="text-cf-muted"> / {round(d.tMin)}°</span>
                </span>
                <span className={`col-start-3 sm:col-start-auto text-xs sm:text-sm sm:text-right tabular-nums whitespace-nowrap flex sm:justify-end items-center gap-1 ${wet ? 'text-cf-primary' : 'text-cf-muted'}`}>
                  <Droplets className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {t('field.weather.mm', { value: mm(d.rainMm ?? 0) })}
                  {d.rainChance != null && <span className="hidden sm:inline text-cf-muted">· {round(d.rainChance)}%</span>}
                </span>
                <span className="text-xs sm:text-sm text-right tabular-nums whitespace-nowrap text-cf-muted flex justify-end items-center gap-1">
                  <Wind className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {t('field.weather.kmh', { value: round(d.gustMax ?? d.windMax) })}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Water balance of the week */}
      <div className={`${card} p-5 sm:p-6 space-y-3`}>
        <h2 className="text-lg font-semibold text-cf-text">{t('field.weather.balanceTitle')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-cf-panel border border-cf-border rounded-lg px-3.5 py-3">
            <p className="text-xs text-cf-muted">{t('field.weather.rainTotal')}</p>
            <p className="text-xl font-semibold text-cf-primary tabular-nums mt-0.5">{t('field.weather.mm', { value: mm(balance.rain) })}</p>
          </div>
          <div className="bg-cf-panel border border-cf-border rounded-lg px-3.5 py-3">
            <p className="text-xs text-cf-muted">{t('field.weather.et0Total')}</p>
            <p className="text-xl font-semibold text-cf-primary tabular-nums mt-0.5">{t('field.weather.mm', { value: mm(balance.et0) })}</p>
          </div>
        </div>
        <p className="text-sm text-cf-muted leading-relaxed">
          {deficit > 5
            ? irrigated
              ? t('field.weather.deficitIrrigated', { mm: mm(deficit) })
              : t('field.weather.deficitRainfed', { mm: mm(deficit) })
            : t('field.weather.noDeficit')}
        </p>
        <p className="text-xs text-cf-muted">{t('field.weather.et0Help')}</p>
      </div>

      <p className="text-xs text-cf-muted">
        {t('field.weather.place', {
          lat: lat!.toLocaleString(locale, { maximumFractionDigits: 3 }),
          lon: lon!.toLocaleString(locale, { maximumFractionDigits: 3 }),
          elevation: round(forecast.elevation),
        })}{' '}
        ·{' '}
        <a href={WEATHER_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-cf-muted">
          {t('field.weather.credit')}
        </a>
      </p>
    </div>
  );
};
import type { MessageKey } from '../../i18n/en';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// "Nov 2024" for a YYYY-MM-DD date
export function monthYear(date: string, locale: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 15));
}

// "12 Nov 2024"
export function fullDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d));
}

// Name of a month (1-12)
export function monthName(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, month - 1, 15));
}

// The period of a season in words: "Nov 2024 – Jun 2025", "Since Nov 2025 · still in the field",
// or the bare year for seasons recorded before periods existed
export function periodLabel(
  t: T,
  locale: string,
  s: { sown_on: string | null; harvested_on: string | null; season_year: number },
): string {
  if (!s.sown_on) return String(s.season_year);
  if (!s.harvested_on) return t('seasons.period.since', { start: monthYear(s.sown_on, locale) });
  const start = monthYear(s.sown_on, locale);
  const end = monthYear(s.harvested_on, locale);
  return start === end ? start : t('seasons.period.range', { start, end });
}
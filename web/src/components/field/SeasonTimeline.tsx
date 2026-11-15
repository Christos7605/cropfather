import React, { useMemo, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { cropName, todayIso, type Crop, type Season } from '../../lib/seasons';

// The field calendar: one row per year, twelve months, one bar per crop from sowing to harvesτ
// A crop still in the field runs to today and fades out. Seasons without dates are not drawn

// Crop colours, picked by crop so a crop keeps its colour everywhere
export const CROP_COLORS = ['#9cc58a', '#e3b55b', '#6fa8d6', '#c9805a', '#9dbcf2', '#c9a3d6', '#b9cc7c', '#e0907a'];

export function cropColor(cropId: string): string {
  let h = 0;
  for (const ch of cropId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CROP_COLORS[h % CROP_COLORS.length];
}

const DEFAULT_YEARS = 4;

const dayOfYear = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000;
};
const daysInYear = (y: number) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);

interface Bar {
  season: Season;
  left: number; // % of the year
  width: number; // % of the year
  openEnd: boolean; // runs into today (still in the field)
  continues: boolean; // goes on into the next row
  continued: boolean; // came from the previous row
}

interface Props {
  seasons: Season[];
  crops: Map<string, Crop>;
  onPick?: (season: Season) => void;
  // A period being edited, drawn on top with a dashed outline
  draft?: { start: string; end: string | null; cropId: string; conflict: boolean } | null;
  // Show only these years (editor preview); otherwise the most recent ones, with "show older"
  focusYears?: number[];
}

export const SeasonTimeline: React.FC<Props> = ({ seasons, crops, onPick, draft, focusYears }) => {
  const { t, language, locale } = useLanguage();
  const [showAll, setShowAll] = useState(false);
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));

  const dated = seasons.filter((s) => s.sown_on);
  const years = useMemo(() => {
    if (focusYears) return [...focusYears].sort((a, b) => b - a);
    const first = Math.min(thisYear, ...dated.map((s) => Number(s.sown_on!.slice(0, 4))));
    const all: number[] = [];
    for (let y = thisYear; y >= first; y--) all.push(y);
    return all;
  }, [dated, focusYears, thisYear]);
  const shown = focusYears || showAll ? years : years.slice(0, DEFAULT_YEARS);

  const barsFor = (year: number, list: { season: Season; start: string; end: string | null }[]): Bar[] => {
    const yStart = `${year}-01-01`;
    const yEnd = `${year + 1}-01-01`;
    const total = daysInYear(year);
    const out: Bar[] = [];
    for (const { season, start, end } of list) {
      const openEnd = end === null;
      const realEnd = end ?? (today < yEnd ? today : yEnd);
      if (start >= yEnd || realEnd <= yStart) continue;
      const from = start < yStart ? 0 : dayOfYear(start);
      const to = realEnd >= yEnd ? total : dayOfYear(realEnd);
      if (to <= from) continue;
      out.push({
        season,
        left: (from / total) * 100,
        width: Math.max(((to - from) / total) * 100, 0.8),
        openEnd: openEnd && realEnd < yEnd,
        continues: realEnd >= yEnd && (end === null || end > yEnd || end === yEnd),
        continued: start < yStart,
      });
    }
    return out;
  };

  const seasonBars = dated.map((s) => ({ season: s, start: s.sown_on!, end: s.harvested_on }));
  const monthLabels = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { month: 'narrow' }).format(new Date(2026, i, 15)),
  );
  const todayLeft = (dayOfYear(today) / daysInYear(thisYear)) * 100;

  return (
    <div className="space-y-2">
      {/* Month initials */}
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-[0.65rem] text-cf-muted">
        <span />
        <div className="grid grid-cols-12">
          {monthLabels.map((m, i) => (
            <span key={i} className="text-center">
              {m}
            </span>
          ))}
        </div>
      </div>

      <ol className="space-y-1.5">
        {shown.map((year) => {
          const bars = barsFor(year, seasonBars);
          const draftBars =
            draft && draft.start
              ? barsFor(year, [
                  {
                    season: { id: -1, crop_id: draft.cropId } as Season,
                    start: draft.start,
                    end: draft.end,
                  },
                ])
              : [];
          return (
            <li key={year} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 items-center">
              <span className="text-xs font-medium text-cf-muted tabular-nums">{year}</span>
              <div className="relative h-8 rounded-md bg-cf-panel border border-cf-border overflow-hidden">
                {/* Month dividers */}
                <div className="absolute inset-0 grid grid-cols-12 pointer-events-none" aria-hidden="true">
                  {monthLabels.map((_, i) => (
                    <span key={i} className={i > 0 ? 'border-l border-cf-border/50' : ''} />
                  ))}
                </div>
                {bars.map((b) => {
                  const name = cropName(crops.get(b.season.crop_id), language, t('seasons.unknownCrop'));
                  const color = cropColor(b.season.crop_id);
                  const Tag = onPick ? 'button' : 'div';
                  return (
                    <Tag
                      key={b.season.id}
                      type={onPick ? 'button' : undefined}
                      onClick={onPick ? () => onPick(b.season) : undefined}
                      title={name}
                      className={`absolute top-1 bottom-1 flex items-center px-1.5 text-[0.7rem] font-semibold text-ground-deep overflow-hidden whitespace-nowrap ${
                        onPick ? 'cursor-pointer hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ink' : ''
                      } ${b.continued ? 'rounded-l-none' : 'rounded-l'} ${b.continues ? 'rounded-r-none' : 'rounded-r'}`}
                      style={{
                        left: `${b.left}%`,
                        width: `${b.width}%`,
                        background: b.openEnd ? `linear-gradient(90deg, ${color} 70%, ${color}33)` : color,
                        opacity: draft ? 0.55 : 1,
                      }}
                    >
                      <span className="truncate">{name}</span>
                    </Tag>
                  );
                })}
                {draftBars.map((b) => (
                  <div
                    key="draft"
                    className={`absolute top-0.5 bottom-0.5 rounded border-2 border-dashed ${
                      draft!.conflict ? 'border-red-300 bg-red-400/25' : 'border-cf-primary bg-cf-primary/15'
                    }`}
                    style={{ left: `${b.left}%`, width: `${b.width}%` }}
                    aria-hidden="true"
                  />
                ))}
                {year === thisYear && (
                  <span
                    className="absolute top-0 bottom-0 w-0.5 bg-signal/80"
                    style={{ left: `${todayLeft}%` }}
                    title={t('seasons.timeline.today')}
                    aria-hidden="true"
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {!focusYears && years.length > DEFAULT_YEARS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-cf-muted hover:text-cf-text underline underline-offset-2 cursor-pointer"
        >
          {showAll ? t('seasons.timeline.newer') : t('seasons.timeline.older')}
        </button>
      )}
    </div>
  );
};
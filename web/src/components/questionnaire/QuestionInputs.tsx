import React, { useEffect, useState } from 'react';
import { Check, CircleHelp, Loader2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { cropName, listCrops, type Crop } from '../../lib/seasons';
import { NONE, UNKNOWN, type AnswerValue, type Question } from '../../lib/questionnaire';

// One input per question type. Every input is controlled: value in, onChange out
interface InputProps<Q extends Question> {
  question: Q;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
}

const chipBase =
  'px-3.5 py-2 rounded-lg border text-sm font-medium transition-colors cursor-pointer flex items-center justify-center gap-1.5 [&_svg]:shrink-0';
const chipOn = 'bg-cf-hero border-cf-primary/50 text-cf-text';
const chipOff = 'bg-cf-panel border-cf-primary/20 text-cf-muted hover:border-cf-primary/45 hover:text-cf-text';
const chip = (on: boolean) => `${chipBase} ${on ? chipOn : chipOff}`;

const UnknownChip: React.FC<{ on: boolean; onToggle: () => void }> = ({ on, onToggle }) => {
  const { t } = useLanguage();
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onToggle} className={chip(on)}>
      <CircleHelp className="w-3.5 h-3.5" aria-hidden="true" />
      {t('questionnaire.dontKnow')}
    </button>
  );
};

// Single choice shown as cards (with an optional one-line description)
export const SingleChoice: React.FC<InputProps<Extract<Question, { type: 'single' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  const withDesc = question.options.some((o) => o.descKey);
  return (
    <div className="space-y-2.5">
      <div
        role="radiogroup"
        aria-labelledby={`${question.id}-title`}
        className={`grid gap-2 ${
          withDesc
            ? question.options.length === 3
              ? 'grid-cols-1 sm:grid-cols-3'
              : 'grid-cols-1 sm:grid-cols-2'
            : question.options.length === 3
              ? 'grid-cols-1 sm:grid-cols-3'
              : question.options.length === 2
                ? 'grid-cols-2'
                : 'grid-cols-2 sm:grid-cols-4'
        }`}
      >
        {question.options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(on ? undefined : o.value)}
              className={`text-left rounded-lg border px-3.5 py-3 transition-colors cursor-pointer flex items-start gap-3 ${
                on ? chipOn : chipOff
              }`}
            >
              <span
                className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  on ? 'border-cf-primary' : 'border-cf-primary/35'
                }`}
                aria-hidden="true"
              >
                {on && <span className="w-2 h-2 rounded-full bg-cf-primary" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(o.labelKey)}</span>
                {o.descKey && <span className="block text-xs text-cf-muted mt-0.5">{t(o.descKey)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {question.allowUnknown && (
        <div className="flex">
          <UnknownChip on={value === UNKNOWN} onToggle={() => onChange(value === UNKNOWN ? undefined : UNKNOWN)} />
        </div>
      )}
    </div>
  );
};

// Several choices as chips, with an optional maximum
export const MultiChoice: React.FC<InputProps<Extract<Question, { type: 'multi' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  const selected = Array.isArray(value) ? value.map(String) : [];
  const full = question.max !== undefined && selected.length >= question.max;

  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange(next.length ? next : undefined);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${question.id}-title`}>
        {question.options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={!on && full}
              onClick={() => toggle(o.value)}
              className={`${chip(on)} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {on && <Check className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />}
              {t(o.labelKey)}
            </button>
          );
        })}
      </div>
      {question.max !== undefined && (
        <p className="text-xs text-cf-muted tabular-nums">
          {t('questionnaire.chooseUpTo', { max: String(question.max) })} {selected.length}/{question.max}
        </p>
      )}
    </div>
  );
};

// Chips that may be combined, plus exclusive extras ("none", "I don't know") that clear the rest
// Shared by the years and months questions
const ChipGrid: React.FC<{
  labelledBy: string;
  items: { value: number; label: string }[];
  extras: { value: string; label: string }[];
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue | undefined) => void;
  cols: string;
}> = ({ labelledBy, items, extras, value, onChange, cols }) => {
  const list = Array.isArray(value) ? value : [];
  const extra = list.find((v) => typeof v === 'string') as string | undefined;
  const picked = list.filter((v): v is number => typeof v === 'number');

  const toggleItem = (v: number) => {
    const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v].sort((a, b) => a - b);
    onChange(next.length ? next : undefined);
  };
  const toggleExtra = (v: string) => onChange(extra === v ? undefined : [v]);

  return (
    <div className="space-y-2.5">
      <div className={`grid gap-2 ${cols}`} role="group" aria-labelledby={labelledBy}>
        {items.map((it) => {
          const on = picked.includes(it.value);
          return (
            <button
              key={it.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggleItem(it.value)}
              className={`${chip(on)} px-2 tabular-nums`}
            >
              {it.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {extras.map((x) =>
          x.value === UNKNOWN ? (
            <UnknownChip key={x.value} on={extra === x.value} onToggle={() => toggleExtra(x.value)} />
          ) : (
            <button
              key={x.value}
              type="button"
              role="checkbox"
              aria-checked={extra === x.value}
              onClick={() => toggleExtra(x.value)}
              className={chip(extra === x.value)}
            >
              {x.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
};

export const YearsChoice: React.FC<InputProps<Extract<Question, { type: 'years' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  const thisYear = new Date().getFullYear();
  const items = Array.from({ length: question.span }, (_, i) => thisYear - question.span + 1 + i).map((y) => ({
    value: y,
    label: String(y),
  }));
  return (
    <ChipGrid
      labelledBy={`${question.id}-title`}
      items={items}
      extras={[
        { value: NONE, label: t('questionnaire.noneYears') },
        { value: UNKNOWN, label: t('questionnaire.dontKnow') },
      ]}
      value={value}
      onChange={onChange}
      cols="grid-cols-3 sm:grid-cols-5"
    />
  );
};

export const MonthsChoice: React.FC<InputProps<Extract<Question, { type: 'months' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t, locale } = useLanguage();
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short' });
  const items = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: fmt.format(new Date(2026, i, 1)).replace('.', ''),
  }));
  return (
    <ChipGrid
      labelledBy={`${question.id}-title`}
      items={items}
      extras={[{ value: UNKNOWN, label: t('questionnaire.dontKnow') }]}
      value={value}
      onChange={onChange}
      cols="grid-cols-4 sm:grid-cols-6"
    />
  );
};

function snapToStep(value: number, min: number, max: number, step: number): number {
  const steps = Math.round((value - min) / step);
  const snapped = Math.round((min + steps * step) * 1000) / 1000;
  return Math.min(max, Math.max(min, snapped));
}

// Slider on fixed steps. Nothing is stored until the farmer moves or releases it.
export const RangeChoice: React.FC<InputProps<Extract<Question, { type: 'range' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t, locale } = useLanguage();
  const chosen = typeof value === 'number' ? snapToStep(value, question.min, question.max, question.step) : null;
  const shown = chosen ?? question.min;
  const months = (n: number) =>
    n.toLocaleString(locale, { minimumFractionDigits: Number.isInteger(n) ? 0 : 1, maximumFractionDigits: 1 });
  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange(snapToStep(n, question.min, question.max, question.step));
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-cf-text tabular-nums" aria-live="polite">
        {chosen == null
          ? t('fieldQuestionnaire.q.maxMonths.unset')
          : t('fieldQuestionnaire.q.maxMonths.value', { months: months(chosen) })}
      </p>
      <input
        type="range"
        min={question.min}
        max={question.max}
        step={question.step}
        value={shown}
        aria-labelledby={`${question.id}-title`}
        aria-valuemin={question.min}
        aria-valuemax={question.max}
        aria-valuenow={shown}
        aria-valuetext={
          chosen == null
            ? t('fieldQuestionnaire.q.maxMonths.unset')
            : t('fieldQuestionnaire.q.maxMonths.value', { months: months(chosen) })
        }
        onChange={(e) => commit(e.target.value)}
        onPointerUp={(e) => commit((e.target as HTMLInputElement).value)}
        className="w-full accent-cf-primary cursor-pointer"
      />
      <div className="flex justify-between text-xs text-cf-muted tabular-nums" aria-hidden="true">
        <span>{t('fieldQuestionnaire.q.maxMonths.value', { months: months(question.min) })}</span>
        <span>{t('fieldQuestionnaire.q.maxMonths.value', { months: months(question.max) })}</span>
      </div>
    </div>
  );
};

// 1-5 scale with labels at both ends
export const ScaleChoice: React.FC<InputProps<Extract<Question, { type: 'scale' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  return (
    <div className="space-y-2.5">
      <div role="radiogroup" aria-labelledby={`${question.id}-title`} className="grid grid-cols-5 gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={
                n === 1 ? `1 (${t(question.lowKey)})` : n === 5 ? `5 (${t(question.highKey)})` : String(n)
              }
              onClick={() => onChange(on ? undefined : n)}
              className={`h-11 rounded-lg border text-sm font-semibold tabular-nums transition-colors cursor-pointer ${
                on ? 'bg-cf-primary/20 border-cf-primary text-cf-text' : chipOff
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-cf-muted" aria-hidden="true">
        <span>{t(question.lowKey)}</span>
        <span>{t(question.highKey)}</span>
      </div>
      <div className="flex">
        <UnknownChip on={value === UNKNOWN} onToggle={() => onChange(value === UNKNOWN ? undefined : UNKNOWN)} />
      </div>
    </div>
  );
};

// A year typed by the farmer, or "never" / "I don't know"
export const YearInput: React.FC<InputProps<Extract<Question, { type: 'year' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  const min = 1950;
  const max = new Date().getFullYear();
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  const [invalid, setInvalid] = useState(false);

  // Follow outside changes: a saved year fills the box, "never"/"I don't know" empties it
  // An empty answer leaves the box alone, so a half-typed year is not wiped
  useEffect(() => {
    if (typeof value === 'number') setText(String(value));
    else if (typeof value === 'string') setText('');
  }, [value]);

  const commit = (raw: string) => {
    setText(raw);
    const s = raw.trim();
    if (!s) {
      setInvalid(false);
      if (typeof value === 'number') onChange(undefined);
      return;
    }
    const n = Number(s);
    const ok = /^\d{4}$/.test(s) && n >= min && n <= max;
    setInvalid(!ok);
    if (ok) onChange(n);
  };

  const extra = typeof value === 'string' ? value : undefined;
  const toggleExtra = (v: string) => {
    setInvalid(false);
    setText('');
    onChange(extra === v ? undefined : v);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-36">
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={text}
            onChange={(e) => commit(e.target.value.replace(/\D/g, ''))}
            placeholder={t('questionnaire.yearPlaceholder')}
            aria-labelledby={`${question.id}-title`}
            aria-invalid={invalid || undefined}
            className="w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2 text-sm text-cf-text tabular-nums placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors"
          />
        </div>
        <button
          type="button"
          role="checkbox"
          aria-checked={extra === NONE}
          onClick={() => toggleExtra(NONE)}
          className={chip(extra === NONE)}
        >
          {t(question.noneKey)}
        </button>
        <UnknownChip on={extra === UNKNOWN} onToggle={() => toggleExtra(UNKNOWN)} />
      </div>
      {invalid && (
        <p className="text-xs text-red-800" role="alert">
          {t('questionnaire.yearInvalid', { min: String(min), max: String(max) })}
        </p>
      )}
    </div>
  );
};

export const TextAnswer: React.FC<InputProps<Extract<Question, { type: 'text' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t } = useLanguage();
  const text = typeof value === 'string' ? value : '';
  return (
    <div className="space-y-1.5">
      <textarea
        value={text}
        maxLength={question.maxLength}
        rows={4}
        onChange={(e) => onChange(e.target.value ? e.target.value : undefined)}
        placeholder={question.placeholderKey ? t(question.placeholderKey) : undefined}
        aria-labelledby={`${question.id}-title`}
        className="w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors resize-y min-h-24"
      />
      <p className="text-xs text-cf-muted text-right tabular-nums">
        {t('questionnaire.charsLeft', { count: String(question.maxLength - text.length) })}
      </p>
    </div>
  );
};

// Crops the farmer will not grow. [NONE] means they would grow any crop in the list.
export const CropExclude: React.FC<InputProps<Extract<Question, { type: 'cropExclude' }>>> = ({
  question,
  value,
  onChange,
}) => {
  const { t, language } = useLanguage();
  const [crops, setCrops] = useState<Crop[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listCrops()
      .then((rows) => {
        if (cancelled) return;
        const growable = rows.filter(
          (crop) => crop.id !== 'fallow' && crop.id !== 'other' && crop.main_product !== 'none',
        );
        growable.sort((a, b) =>
          cropName(a, language, a.id).localeCompare(cropName(b, language, b.id), language),
        );
        setCrops(growable);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const selected = Array.isArray(value) ? value.map(String) : [];
  const any = selected.length === 1 && selected[0] === NONE;
  const excluded = any ? [] : selected.filter((id) => id !== NONE && id !== 'other');

  const chooseAny = () => onChange(any ? undefined : [NONE]);
  const toggle = (id: string) => {
    const next = excluded.includes(id) ? excluded.filter((item) => item !== id) : [...excluded, id];
    onChange(next.length ? next : undefined);
  };

  if (failed) {
    return (
      <p className="text-sm text-red-900" role="alert">
        {t('farmProfile.q.excludedCrops.loadFailed')}
      </p>
    );
  }
  if (!crops) {
    return (
      <p className="text-sm text-cf-muted flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        {t('farmProfile.q.excludedCrops.loading')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-cf-muted tabular-nums">
        {any
          ? t('farmProfile.q.excludedCrops.any')
          : t('farmProfile.q.excludedCrops.count', { count: String(excluded.length) })}
      </p>
      <button
        type="button"
        role="checkbox"
        aria-checked={any}
        onClick={chooseAny}
        className={`w-full text-left rounded-xl border px-3.5 py-3 transition-colors cursor-pointer flex items-center gap-3 ${
          any ? chipOn : chipOff
        }`}
      >
        <span
          className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
            any ? 'border-cf-primary bg-cf-primary text-cf-panel' : 'border-cf-primary/35'
          }`}
          aria-hidden="true"
        >
          {any && <Check className="w-3 h-3" />}
        </span>
        <span className="text-sm font-medium">{t('farmProfile.q.excludedCrops.any')}</span>
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" role="group" aria-labelledby={`${question.id}-title`}>
        {crops.map((crop) => {
          const on = excluded.includes(crop.id);
          return (
            <button
              key={crop.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(crop.id)}
              className={`text-left rounded-xl border px-3.5 py-3 transition-colors cursor-pointer flex items-start gap-3 ${
                on ? chipOn : chipOff
              }`}
            >
              <span
                className={`mt-0.5 w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
                  on ? 'border-cf-primary bg-cf-primary text-cf-panel' : 'border-cf-primary/35'
                }`}
                aria-hidden="true"
              >
                {on && <Check className="w-3 h-3" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{cropName(crop, language, crop.id)}</span>
                {on && <span className="block text-xs text-cf-muted mt-0.5">{t('farmProfile.q.excludedCrops.wontGrow')}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const QuestionInput: React.FC<InputProps<Question>> = ({ question, value, onChange }) => {
  switch (question.type) {
    case 'single':
      return <SingleChoice question={question} value={value} onChange={onChange} />;
    case 'multi':
      return <MultiChoice question={question} value={value} onChange={onChange} />;
    case 'years':
      return <YearsChoice question={question} value={value} onChange={onChange} />;
    case 'months':
      return <MonthsChoice question={question} value={value} onChange={onChange} />;
    case 'scale':
      return <ScaleChoice question={question} value={value} onChange={onChange} />;
    case 'range':
      return <RangeChoice question={question} value={value} onChange={onChange} />;
    case 'year':
      return <YearInput question={question} value={value} onChange={onChange} />;
    case 'text':
      return <TextAnswer question={question} value={value} onChange={onChange} />;
    case 'cropExclude':
      return <CropExclude question={question} value={value} onChange={onChange} />;
  }
};
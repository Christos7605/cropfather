import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, ClipboardList, Loader2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { describeError } from '../../lib/fields';
import {
  FIELD_QUESTIONNAIRE,
  NONE,
  UNKNOWN,
  countAnswered,
  countedQuestions,
  isAnswered,
  loadFieldResponse,
  type AnswerValue,
  type Answers,
  type Question,
  type QuestionnaireResponse,
} from '../../lib/questionnaire';
import { ErrorBox } from '../questionnaire/QuestionnaireWizard';

// The field questionnaire inside the field page: progress and the answers given so far,
// read-only. Answering happens in the step-by-step wizard (/fields/:id/questionnaire)

export const QuestionnaireTab: React.FC<{ fieldId: string }> = ({ fieldId }) => {
  const { t, locale } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [response, setResponse] = useState<QuestionnaireResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setResponse(await loadFieldResponse(fieldId));
      setState('ready');
    } catch (err) {
      setError(describeError(err, tRef.current));
      setState('error');
    }
  }, [fieldId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') {
    return (
      <p className="py-10 text-sm text-cf-muted flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('questionnaire.loading')}
      </p>
    );
  }
  if (state === 'error') {
    return <ErrorBox message={`${t('questionnaire.loadFailed')} ${error ?? ''}`} onRetry={() => void load()} />;
  }

  const answers: Answers = response?.answers ?? {};
  const total = countedQuestions(FIELD_QUESTIONNAIRE).length;
  const answered = countAnswered(FIELD_QUESTIONNAIRE, answers);
  const done = response?.status === 'submitted';
  const percent = total ? Math.round((answered / total) * 100) : 0;
  const to = `/fields/${encodeURIComponent(fieldId)}/questionnaire`;

  const monthName = (m: number) =>
    new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, m - 1, 1));

  const formatAnswer = (q: Question, value: AnswerValue | undefined): string | null => {
    if (value === undefined || !isAnswered(value)) return null;
    if (value === UNKNOWN) return t('questionnaire.dontKnow');
    switch (q.type) {
      case 'single': {
        const option = q.options.find((o) => o.value === value);
        return option ? t(option.labelKey) : String(value);
      }
      case 'multi': {
        const list = Array.isArray(value) ? value : [value];
        return list.map((v) => {
          const option = q.options.find((o) => o.value === v);
          return option ? t(option.labelKey) : String(v);
        }).join(', ');
      }
      case 'years': {
        const list = Array.isArray(value) ? value : [value];
        if (list.includes(NONE)) return t('questionnaire.noneYears');
        if (list.includes(UNKNOWN)) return t('questionnaire.dontKnow');
        return [...list].map(Number).sort((a, b) => a - b).join(', ');
      }
      case 'months': {
        const list = Array.isArray(value) ? value : [value];
        if (list.includes(UNKNOWN)) return t('questionnaire.dontKnow');
        return [...list].map(Number).sort((a, b) => a - b).map(monthName).join(', ');
      }
      case 'scale':
        return t('field.questionnaire.scaleValue', { value: String(value), low: t(q.lowKey), high: t(q.highKey) });
      case 'year':
        return value === NONE ? t(q.noneKey) : String(value);
      case 'text':
        return String(value);
      case 'cropExclude':
        return null;
    }
  };

  return (
    <div className="space-y-5">
      {/* Progress and the way into the wizard */}
      <div className="cf-glass-box rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
        <div className="flex gap-4 min-w-0 flex-1">
          <span className="inline-flex p-2.5 h-fit rounded-lg bg-cf-hero/15 text-cf-primary shrink-0">
            <ClipboardList className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2">
              {t('fieldQuestionnaire.card.title')}
              {done && <CheckCircle2 className="w-4 h-4 text-cf-primary" aria-hidden="true" />}
            </h2>
            {response ? (
              <div className="space-y-1.5 max-w-sm">
                <p className="text-sm text-cf-muted tabular-nums">
                  {done
                    ? t('fieldQuestionnaire.card.submitted', { answered: String(answered), total: String(total) })
                    : t('fieldQuestionnaire.card.inProgress', { answered: String(answered), total: String(total) })}
                </p>
                <div className="h-1.5 rounded-full bg-cf-primary/20 overflow-hidden" aria-hidden="true">
                  <div className="h-full rounded-full bg-cf-primary" style={{ width: `${percent}%` }} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-cf-muted leading-relaxed">{t('fieldQuestionnaire.card.notStarted')}</p>
            )}
          </div>
        </div>
        <Link
          to={to}
          className={`px-5 py-3 rounded-lg text-sm flex items-center justify-center gap-2 shrink-0 ${
            done
              ? 'border border-cf-border text-cf-muted hover:text-cf-text hover:border-cf-border-strong hover:bg-cf-hero transition-colors font-medium'
              : 'cf-btn-primary'
          }`}
        >
          {done
            ? t('fieldQuestionnaire.card.review')
            : response
              ? t('fieldQuestionnaire.card.continue')
              : t('fieldQuestionnaire.card.start')}
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Answers so far, section by section */}
      {response &&
        FIELD_QUESTIONNAIRE.sections.map((section) => (
          <section key={section.id} className="cf-glass-box rounded-2xl overflow-hidden" aria-labelledby={`fs-qs-${section.id}`}>
            <header className="px-5 sm:px-6 py-4 border-b border-cf-border">
              <h3 id={`fs-qs-${section.id}`} className="text-base font-semibold text-cf-text">
                {t(section.titleKey)}
              </h3>
            </header>
            <dl className="divide-y divide-cf-border">
              {section.questions.map((q) => {
                const text = formatAnswer(q, answers[q.id]);
                return (
                  <div key={q.id} className="px-5 sm:px-6 py-3.5 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] gap-1 sm:gap-6">
                    <dt className="text-sm text-cf-muted leading-snug">{t(q.titleKey)}</dt>
                    <dd className={`text-sm leading-snug break-words sm:text-right ${text ? 'text-cf-text font-medium' : 'text-cf-muted italic'}`}>
                      {text ?? t('field.questionnaire.notAnswered')}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
    </div>
  );
};
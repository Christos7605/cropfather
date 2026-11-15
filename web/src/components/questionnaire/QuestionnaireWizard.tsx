import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { describeError } from '../../lib/fields';
import { setUnsavedMessage } from '../../lib/navigationGuard';
import {
  countAnswered,
  countedQuestions,
  effectiveStatus,
  isAnswered,
  type AnswerValue,
  type Answers,
  type QuestionnaireDef,
  type QuestionnaireResponse,
  type ResponseStatus,
  type Section,
} from '../../lib/questionnaire';
import { QuestionInput } from './QuestionInputs';

export type IconType = React.ComponentType<{ className?: string }>;

export interface WizardApi {
  answers: Answers;
  // Replaces every answer at once (e.g. copied from another field); autosave follows
  replaceAll: (answers: Answers) => void;
  answered: number;
}

interface Props {
  def: QuestionnaireDef;
  load: () => Promise<QuestionnaireResponse | null>;
  save: (answers: Answers, status: ResponseStatus) => Promise<QuestionnaireResponse>;
  icon: IconType;
  sectionIcons: Record<string, IconType>;
  title: string;
  intro: string;
  privacy: string;
  back: { to: string; label: string };
  // Shown next to the title (e.g. the field name)
  badge?: React.ReactNode;
  // Shown under the progress bar (e.g. "copy from another field")
  extras?: (api: WizardApi) => React.ReactNode;
  doneDesc: string;
  // Buttons of the thank-you screen; `review` goes back to step 1
  doneActions: (review: () => void) => React.ReactNode;
}

const SAVE_DELAY_MS = 900;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export const secondaryBtn =
  'cf-btn-glass-sage px-4 py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50 [&_svg]:shrink-0';

export const QuestionnaireWizard: React.FC<Props> = ({
  def,
  load,
  save: saveRemote,
  icon: Icon,
  sectionIcons,
  title,
  intro,
  privacy,
  back,
  badge,
  extras,
  doneDesc,
  doneActions,
}) => {
  const [params, setParams] = useSearchParams();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [status, setStatus] = useState<ResponseStatus>('draft');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const sections = def.sections;
  const stepCount = sections.length;
  const step = Math.min(Math.max(Number(params.get('step') ?? '1') || 1, 1), stepCount) - 1;
  const section = sections[step];

  // Refs read by the save logic, so it always sees the latest values
  const lastSavedRef = useRef('{}');
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const statusRef = useRef(status);
  statusRef.current = status;
  const defRef = useRef(def);
  defRef.current = def;
  const timerRef = useRef<number | undefined>(undefined);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const saveRemoteRef = useRef(saveRemote);
  saveRemoteRef.current = saveRemote;

  // Load saved answers
  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const saved = await loadRef.current();
      const initial = saved?.answers ?? {};
      lastSavedRef.current = JSON.stringify(initial);
      setAnswers(initial);
      setStatus(saved?.status ?? 'draft');
    } catch (err) {
      setLoadError(describeError(err, tRef.current));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Autosave: shortly after the last change, and immediately on Finish
  const dirty = JSON.stringify(answers) !== lastSavedRef.current;

  const save = useCallback(async (nextStatus?: ResponseStatus): Promise<boolean> => {
    window.clearTimeout(timerRef.current);
    // Wait for a save already on its way, so two saves never race
    if (savingRef.current) await savingRef.current;
    const snapshot = answersRef.current;
    // Completed whenever every counted question has an answer, in progress otherwise
    const wanted = effectiveStatus(defRef.current, snapshot, nextStatus ?? 'submitted');
    if (JSON.stringify(snapshot) === lastSavedRef.current && wanted === statusRef.current) return true;

    const job = (async () => {
      setSaveState('saving');
      setSaveError(null);
      try {
        const saved = await saveRemoteRef.current(snapshot, wanted);
        lastSavedRef.current = JSON.stringify(snapshot);
        setStatus(saved.status);
        setSaveState('saved');
        return true;
      } catch (err) {
        setSaveState('error');
        setSaveError(describeError(err, tRef.current));
        return false;
      }
    })();
    savingRef.current = job;
    const ok = await job;
    savingRef.current = null;
    return ok;
  }, []);

  useEffect(() => {
    if (loading || !dirty) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [answers, loading, dirty, save]);

  // Warn before leaving while answers are not saved yet (tab close, or the header links)
  const unsaved = dirty || saveState === 'saving';
  useEffect(() => {
    if (!unsaved) {
      setUnsavedMessage(null);
      return;
    }
    const message = t('questionnaire.unsavedLeave');
    setUnsavedMessage(message);
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      setUnsavedMessage(null);
    };
  }, [unsaved, t]);

  // Leaving by an in-page link: send what is still pending
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      if (JSON.stringify(answersRef.current) !== lastSavedRef.current) {
        void saveRemoteRef.current(answersRef.current, 'submitted').catch(() => {});
      }
    },
    [],
  );

  // Steps
  const topRef = useRef<HTMLDivElement>(null);
  const goTo = (index: number) => {
    const next = new URLSearchParams(params);
    next.set('step', String(index + 1));
    setParams(next, { replace: true });
    setDone(false);
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const finish = async () => {
    if (await save('submitted')) {
      setDone(true);
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const setAnswer = (id: string, value: AnswerValue | undefined) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  };

  const answered = countAnswered(def, answers);
  const total = countedQuestions(def).length;
  const percent = total ? Math.round((answered / total) * 100) : 0;
  const perSection = useMemo(
    () =>
      sections.map((s) => {
        const counted = s.questions.filter((q) => !q.optional);
        return { answered: counted.filter((q) => isAnswered(answers[q.id])).length, total: counted.length };
      }),
    [sections, answers],
  );
  const questionOffset = sections.slice(0, step).reduce((n, s) => n + s.questions.length, 0);

  const api: WizardApi = { answers, replaceAll: (next) => setAnswers(next), answered };

  // Render
  if (loading) {
    return (
      <div className="cf-dashboard flex-1">
        <div className="px-4 sm:px-8 py-16 flex justify-center">
        <p className="text-sm text-cf-muted flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('questionnaire.loading')}
        </p>
      </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="cf-dashboard flex-1">
        <div className="px-4 sm:px-8 py-12 max-w-2xl mx-auto w-full space-y-5">
        <Link to={back.to} className="text-sm text-cf-muted hover:text-cf-text inline-flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          {back.label}
        </Link>
        <ErrorBox message={`${t('questionnaire.loadFailed')} ${loadError}`} onRetry={() => void reload()} />
        </div>
      </div>
    );
  }

  return (
    <div className="cf-dashboard flex-1">
    <div ref={topRef} className="px-4 sm:px-8 py-6 sm:py-10 max-w-5xl mx-auto w-full space-y-6 scroll-mt-24">
      {/* Header */}
      <div className="space-y-4">
        <Link to={back.to} className="text-sm text-cf-muted hover:text-cf-text inline-flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          {back.label}
        </Link>

        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-3">
              <span className="cf-glass-pill inline-flex p-2.5 rounded-xl text-cf-primary">
                <Icon className="w-5 h-5" />
              </span>
              <h1 className="font-sans text-2xl sm:text-3xl font-semibold tracking-tight text-cf-text">{title}</h1>
            </div>
            <p className="text-sm sm:text-base text-cf-muted leading-relaxed">{intro}</p>
          </div>
          {badge}
        </div>

        {/* On a phone the section list is not sticky, so the progress stays with the title. */}
        <div className="lg:hidden">
          <ProgressCard
            answered={answered}
            total={total}
            percent={percent}
            saveState={saveState}
            saveError={saveError}
            onRetry={() => void save()}
          />
        </div>

        {extras?.(api)}
      </div>

      {/* Mobile: steps as a scrolling row */}
      <nav className="lg:hidden fs-chip-row flex gap-2 overflow-x-auto -mx-1 px-1 pb-1" aria-label={title}>
        {sections.map((s, i) => (
          <StepButton
            key={s.id}
            section={s}
            icon={sectionIcons[s.id]}
            index={i}
            active={!done && i === step}
            progress={perSection[i]}
            compact
            onClick={() => goTo(i)}
          />
        ))}
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-6 items-start">
        {/* Desktop: steps as a sticky list */}
        <nav className="hidden lg:block lg:sticky lg:top-24 space-y-1.5" aria-label={title}>
          <div className="pb-2">
            <ProgressCard
              answered={answered}
              total={total}
              percent={percent}
              saveState={saveState}
              saveError={saveError}
              onRetry={() => void save()}
            />
          </div>
          {sections.map((s, i) => (
            <StepButton
              key={s.id}
              section={s}
              icon={sectionIcons[s.id]}
              index={i}
              active={!done && i === step}
              progress={perSection[i]}
              onClick={() => goTo(i)}
            />
          ))}
          <p className="pt-3 px-1 text-xs text-cf-muted leading-relaxed flex gap-2">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-cf-primary" aria-hidden="true" />
            <span>{privacy}</span>
          </p>
        </nav>

        {done ? (
          <div className="bg-cf-panel border border-cf-primary/18 rounded-xl p-8 sm:p-10 text-center space-y-5">
            <span className="inline-flex p-3.5 rounded-full bg-cf-primary/15 text-cf-primary">
              <CheckCircle2 className="w-8 h-8" />
            </span>
            <div className="space-y-2">
              <h2 className="font-sans text-2xl font-semibold text-cf-text">{t('questionnaire.doneTitle')}</h2>
              <p className="text-sm text-cf-muted leading-relaxed max-w-md mx-auto">{doneDesc}</p>
              {answered < total && (
                <p className="text-sm text-cf-primary">
                  {t('questionnaire.unanswered', { count: String(total - answered) })}
                </p>
              )}
            </div>
            <div className="flex flex-col sm:flex-row flex-wrap gap-2.5 justify-center">{doneActions(() => goTo(0))}</div>
          </div>
        ) : (
          <section className="bg-cf-panel border border-cf-primary/18 rounded-xl overflow-hidden" aria-labelledby="fs-section-title">
            <header className="px-5 sm:px-7 pt-6 pb-5 border-b border-cf-border">
              <p className="text-xs font-medium text-cf-primary tabular-nums">
                {t('questionnaire.stepOf', { n: String(step + 1), total: String(stepCount) })}
              </p>
              <h2 id="fs-section-title" className="font-sans text-xl font-semibold text-cf-text mt-1">
                {t(section.titleKey)}
              </h2>
              <p className="text-sm text-cf-muted mt-1">{t(section.descKey)}</p>
            </header>

            <ol className="divide-y divide-cf-border">
              {section.questions.map((q, i) => {
                const has = isAnswered(answers[q.id]);
                return (
                  <li key={q.id} className="px-5 sm:px-7 py-6 space-y-3.5">
                    <div className="flex gap-3">
                      <span
                        className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs font-semibold tabular-nums transition-colors ${
                          has ? 'bg-cf-primary/20 border-cf-primary/40 text-cf-primary' : 'bg-cf-bg border-cf-border text-cf-muted'
                        }`}
                        aria-hidden="true"
                      >
                        {has ? <Check className="w-3.5 h-3.5" /> : questionOffset + i + 1}
                      </span>
                      <div className="space-y-1 min-w-0">
                        <h3 id={`${q.id}-title`} className="text-[0.95rem] font-medium text-cf-text leading-snug">
                          {t(q.titleKey)}
                          {q.optional && (
                            <span className="ml-2 align-middle px-2 py-0.5 rounded-full bg-cf-bg border border-cf-border text-[0.7rem] font-normal text-cf-muted">
                              {t('questionnaire.optional')}
                            </span>
                          )}
                        </h3>
                        {q.helpKey && <p className="text-sm text-cf-muted leading-relaxed">{t(q.helpKey)}</p>}
                      </div>
                    </div>
                    <div className="sm:pl-10">
                      <QuestionInput question={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
                    </div>
                  </li>
                );
              })}
            </ol>

            <footer className="px-5 sm:px-7 py-4 border-t border-cf-border bg-cf-bg/40 space-y-3">
              {step === stepCount - 1 && answered < total && (
                <p className="text-sm text-cf-muted">
                  {t('questionnaire.unanswered', { count: String(total - answered) })}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => goTo(step - 1)}
                  disabled={step === 0}
                  className={`${secondaryBtn} disabled:invisible`}
                >
                  <ChevronLeft className="w-4 h-4" />
                  {t('questionnaire.back')}
                </button>
                {step < stepCount - 1 ? (
                  <button
                    type="button"
                    onClick={() => goTo(step + 1)}
                    className="cf-btn-primary px-5 py-2.5 rounded-lg text-sm flex items-center gap-2"
                  >
                    {t('questionnaire.next')}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void finish()}
                    disabled={saveState === 'saving'}
                    className="cf-btn-primary px-5 py-2.5 rounded-lg text-sm flex items-center gap-2"
                  >
                    {saveState === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {t('questionnaire.finish')}
                  </button>
                )}
              </div>
            </footer>
          </section>
        )}
      </div>

      <p className="lg:hidden text-xs text-cf-muted leading-relaxed flex gap-2">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-cf-primary" aria-hidden="true" />
        <span>{privacy}</span>
      </p>
    </div>
    </div>
  );
};


export const ErrorBox: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => {
  const { t } = useLanguage();
  return (
    <div role="alert" className="p-4 bg-red-50 border border-red-700/30 text-red-900 text-sm rounded-xl flex items-start gap-2.5">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" />
      <div className="space-y-2">
        <p>{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="underline cursor-pointer">
            {t('questionnaire.retry')}
          </button>
        )}
      </div>
    </div>
  );
};

const ProgressCard: React.FC<{
  answered: number;
  total: number;
  percent: number;
  saveState: SaveState;
  saveError: string | null;
  onRetry: () => void;
}> = ({ answered, total, percent, saveState, saveError, onRetry }) => {
  const { t } = useLanguage();
  return (
    <div className="cf-glass-box rounded-xl px-3.5 py-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="text-cf-text font-medium tabular-nums">
          {t('questionnaire.progress', { answered: String(answered), total: String(total) })}
        </span>
        <SaveIndicator state={saveState} onRetry={onRetry} />
      </div>
      <div
        className="h-2 rounded-full bg-cf-primary/25 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={answered}
      >
        <div className="h-full rounded-full bg-cf-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      {saveState === 'error' && saveError && (
        <p className="text-xs text-red-800" role="alert">
          {t('questionnaire.saveFailed')} ({saveError})
        </p>
      )}
    </div>
  );
};

const SaveIndicator: React.FC<{ state: SaveState; onRetry: () => void }> = ({ state, onRetry }) => {
  const { t } = useLanguage();
  if (state === 'saving') {
    return (
      <span className="text-xs text-cf-muted flex items-center gap-1.5" aria-live="polite">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t('questionnaire.saving')}
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="text-xs text-cf-primary flex items-center gap-1.5" aria-live="polite">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {t('questionnaire.saved')}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="text-xs text-red-800 flex items-center gap-1.5 hover:underline cursor-pointer"
      >
        <CloudOff className="w-3.5 h-3.5" />
        {t('questionnaire.retry')}
      </button>
    );
  }
  return null;
};

const StepButton: React.FC<{
  section: Section;
  icon: IconType;
  index: number;
  active: boolean;
  progress: { answered: number; total: number };
  compact?: boolean;
  onClick: () => void;
}> = ({ section, icon: Icon, index, active, progress, compact, onClick }) => {
  const { t } = useLanguage();
  const complete = progress.total > 0 && progress.answered === progress.total;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'step' : undefined}
      className={`text-left rounded-xl cursor-pointer flex items-center gap-3 ${
        compact ? 'shrink-0 px-3 py-2' : 'w-full px-3 py-2.5'
      } ${
        active
          ? 'cf-glass-sage text-cf-text'
          : 'border border-transparent text-cf-muted hover:text-cf-text hover:bg-cf-panel transition-colors'
      }`}
    >
      <span
        className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
          complete ? 'bg-cf-hero text-cf-primary' : active ? 'bg-cf-hero text-cf-primary' : 'bg-cf-bg text-cf-muted'
        }`}
        aria-hidden="true"
      >
        {complete ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium truncate">
          {compact ? t(section.titleKey) : `${index + 1}. ${t(section.titleKey)}`}
        </span>
        <span className="block text-xs text-cf-muted tabular-nums">
          {t('questionnaire.sectionProgress', {
            answered: String(progress.answered),
            total: String(progress.total),
          })}
        </span>
      </span>
    </button>
  );
};
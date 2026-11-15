import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, Loader2, Sprout } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { listMyFields, type FieldRecord } from '../lib/fields';
import { surveyProgress } from '../lib/fieldStatus';
import { isFarmQuestionnaireComplete, loadFarmResponse } from '../lib/questionnaire';
import {
  clearRunningPrediction,
  loadRunningPrediction,
  PREDICTION_KINDS,
  PREDICTION_TIMINGS,
  type PredictionKind,
} from '../lib/prediction';

type Gate = 'ready' | 'missing' | 'farm' | 'field' | 'other';
type Phase = 'ndvi' | 'warn' | 'ndviAfter' | 'predict' | 'done';

// The result of a rotation request. The two waits stand in for the NDVI check and the model.
export const PredictionField: React.FC = () => {
  const { fieldId = '' } = useParams();
  const { user } = useAuth();
  const { t } = useLanguage();
  const userId = user?.id ?? null;

  const [field, setField] = useState<FieldRecord | null>(null);
  const [reason, setReason] = useState<Gate | null>(null);

  useEffect(() => {
    if (!userId || !fieldId) return;
    let cancelled = false;
    Promise.all([listMyFields(), loadFarmResponse()])
      .then(([fields, farm]) => {
        if (cancelled) return;
        const match = fields.find((item) => item.id === fieldId) ?? null;
        setField(match);
        const running = loadRunningPrediction(userId);
        if (!match) {
          setReason('missing');
          return;
        }
        if (running && running.fieldId !== fieldId) {
          setReason('other');
          return;
        }
        if (!running) {
          setReason('missing');
          return;
        }
        if (!isFarmQuestionnaireComplete(farm)) {
          setReason('farm');
          return;
        }
        if (surveyProgress(match).state !== 'done') {
          setReason('field');
          return;
        }
        setReason('ready');
      })
      .catch(() => {
        if (!cancelled) setReason('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, fieldId]);

  const blocked =
    reason === 'farm'
      ? t('prediction.blockedFarm')
      : reason === 'field'
        ? t('prediction.blockedField')
        : reason === 'other'
          ? t('prediction.blockedRunning')
          : reason === 'missing'
            ? t('prediction.blocked')
            : null;

  const name = field?.name ?? '';

  return (
    <div className="cf-dashboard flex-1">
      <div className={`px-4 sm:px-8 py-6 sm:py-10 mx-auto w-full space-y-6 ${reason === 'ready' ? 'max-w-5xl' : 'max-w-3xl'}`}>
        <Link to="/prediction" className="inline-flex items-center gap-1.5 text-sm text-cf-muted hover:text-cf-text transition-colors">
          <ArrowLeft className="w-4 h-4" />
          {t('prediction.back')}
        </Link>

        {reason === 'ready' && userId ? (
          <PredictionRun userId={userId} name={name} />
        ) : (
          <div className="cf-glass-box rounded-2xl p-6 sm:p-8 space-y-4">
            <div className="inline-flex p-3 rounded-xl bg-cf-hero text-cf-primary border border-white/70">
              <Sprout className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-semibold text-cf-text">{t('prediction.emptyTitle', { name })}</h1>
            <div className="space-y-3">
              <p className="text-sm text-cf-text leading-relaxed">{blocked ?? t('prediction.loading')}</p>
              <Link to="/prediction" className="cf-btn-primary inline-flex px-4 py-2.5 rounded-xl text-sm items-center gap-2">
                {t('prediction.backToList')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const PredictionRun: React.FC<{ userId: string; name: string }> = ({ userId, name }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('ndvi');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (phase !== 'ndvi') return;
    const id = window.setTimeout(() => setPhase('warn'), PREDICTION_TIMINGS.ndviMs);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'ndviAfter') return;
    const id = window.setTimeout(() => setPhase('predict'), PREDICTION_TIMINGS.ndviAfterOverrideMs);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'predict') return;
    const id = window.setTimeout(() => {
      clearRunningPrediction(userId);
      setPhase('done');
    }, PREDICTION_TIMINGS.predictionMs);
    return () => window.clearTimeout(id);
  }, [phase, userId]);

  useEffect(() => {
    if (phase === 'warn' || phase === 'done') return;
    const duration =
      phase === 'ndvi'
        ? PREDICTION_TIMINGS.ndviMs
        : phase === 'ndviAfter'
          ? PREDICTION_TIMINGS.ndviAfterOverrideMs
          : PREDICTION_TIMINGS.predictionMs;
    const start = performance.now();
    setProgress(0);
    const id = window.setInterval(() => {
      setProgress(Math.min(1, (performance.now() - start) / duration));
    }, 80);
    return () => window.clearInterval(id);
  }, [phase]);

  const cancel = () => {
    clearRunningPrediction(userId);
    navigate('/prediction');
  };

  const ndviDone = phase === 'predict' || phase === 'done';
  const predictActive = phase === 'predict';
  const predictDone = phase === 'done';
  const phaseLabel = ndviDone ? t('prediction.predictPhase') : t('prediction.ndviPhase');

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-semibold text-cf-text">
          {phase === 'done' ? t('prediction.resultsTitle', { name }) : t('prediction.emptyTitle', { name })}
        </h1>
        {phase === 'done' && (
          <p className="text-sm sm:text-base text-cf-muted leading-relaxed max-w-2xl">{t('prediction.resultsIntro')}</p>
        )}
      </div>

      {phase !== 'done' && (
        <section className="cf-glass-box rounded-2xl p-6 sm:p-8 space-y-5" aria-busy={phase !== 'warn'}>
          <ol className="space-y-3">
            <PhaseRow
              label={t('prediction.ndviPhase')}
              state={ndviDone ? 'done' : 'active'}
              spinning={phase === 'ndvi' || phase === 'ndviAfter'}
            />
            <PhaseRow
              label={t('prediction.predictPhase')}
              state={predictDone ? 'done' : predictActive ? 'active' : 'waiting'}
              spinning={predictActive}
            />
          </ol>

          {phase !== 'warn' && (
            <div
              className="h-1.5 rounded-full bg-cf-hero overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              aria-valuetext={phaseLabel}
            >
              <div className="h-full bg-cf-primary rounded-full" style={{ width: `${progress * 100}%` }} />
            </div>
          )}

          <p className="text-sm font-medium text-cf-text" role="status" aria-live="polite">
            {phaseLabel}
          </p>

          {phase === 'warn' && (
            <div className="cf-glass-sage rounded-2xl px-5 py-4 space-y-4">
              <div className="flex gap-3">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-cf-text">{t('prediction.ndviWarningTitle')}</p>
                  <p className="text-sm text-cf-text leading-relaxed">{t('prediction.ndviWarningBody')}</p>
                  <p className="text-sm text-cf-muted leading-relaxed">{t('prediction.overrideHint')}</p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2.5">
                <button
                  type="button"
                  onClick={cancel}
                  className="cf-btn-secondary px-4 py-2.5 rounded-xl text-sm"
                >
                  {t('prediction.cancelRun')}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase('ndviAfter')}
                  className="cf-btn-primary px-4 py-2.5 rounded-xl text-sm"
                >
                  {t('prediction.override')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {phase === 'done' && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PREDICTION_KINDS.map((kind) => (
            <ResultCard key={kind} kind={kind} />
          ))}
        </ul>
      )}
    </div>
  );
};

const PhaseRow: React.FC<{
  label: string;
  state: 'active' | 'done' | 'waiting';
  spinning: boolean;
}> = ({ label, state, spinning }) => (
  <li className="flex items-center gap-3">
    <span
      className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${
        state === 'waiting'
          ? 'bg-cf-panel border-cf-border text-cf-muted'
          : 'bg-cf-hero border-white/70 text-cf-primary'
      }`}
      aria-hidden="true"
    >
      {state === 'done' ? (
        <Check className="w-4 h-4" />
      ) : spinning ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
      )}
    </span>
    <span className={`text-sm ${state === 'waiting' ? 'text-cf-muted' : 'font-medium text-cf-text'}`}>{label}</span>
  </li>
);

const ResultCard: React.FC<{ kind: PredictionKind }> = ({ kind }) => {
  const { t } = useLanguage();
  return (
    <li className="bg-cf-panel border border-cf-primary/18 rounded-2xl p-5 sm:p-6 space-y-2">
      <h2 className="text-base font-semibold text-cf-text">{t(`prediction.kind.${kind}`)}</h2>
      <p className="text-sm text-cf-muted leading-relaxed">{t('prediction.placeholder')}</p>
    </li>
  );
};

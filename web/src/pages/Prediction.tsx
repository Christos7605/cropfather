import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronRight, ClipboardList, MapPin, Sprout } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { describeError, listMyFields, type FieldRecord } from '../lib/fields';
import { fieldPath, surveyProgress } from '../lib/fieldStatus';
import { isFarmQuestionnaireComplete, loadFarmResponse } from '../lib/questionnaire';
import {
  choosePrediction,
  clearRunningPrediction,
  dispatchNdvi,
  loadPredictionRun,
  loadRunningPrediction,
  predictionWorkerLive,
  recordPredictionRequest,
  saveRunningPrediction,
  startPredictionRun,
  type RunningPrediction,
} from '../lib/prediction';

export const Prediction: React.FC = () => {
  const { user } = useAuth();
  const { t, locale } = useLanguage();
  const navigate = useNavigate();
  const userId = user?.id ?? null;

  const [fields, setFields] = useState<FieldRecord[]>([]);
  const [farmReady, setFarmReady] = useState(false);
  const [running, setRunning] = useState<RunningPrediction | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workerDown, setWorkerDown] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([listMyFields(), loadFarmResponse(), predictionWorkerLive()])
      .then(async ([fieldList, farm, live]) => {
        if (cancelled) return;
        const stored = loadRunningPrediction(userId);
        let stillThere = stored && fieldList.some((field) => field.id === stored.fieldId) ? stored : null;
        let stopped = false;
        if (stillThere && !live) {
          const row = await loadPredictionRun(stillThere.runId);
          if (!cancelled && row && row.via !== 'github' && (row.status === 'ndvi' || row.status === 'running')) {
            await choosePrediction(stillThere.runId, 'cancel').catch(() => undefined);
            clearRunningPrediction(userId);
            stillThere = null;
            stopped = true;
          }
        }
        if (cancelled) return;
        setFields(fieldList);
        setFarmReady(isFarmQuestionnaireComplete(farm));
        setRunning(stillThere);
        setWorkerDown(stopped);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, t]);

  const ha = (value: number | null) =>
    value == null ? '–' : value.toLocaleString(locale, { maximumFractionDigits: 2 });

  const start = async (field: FieldRecord) => {
    if (!userId || !farmReady || running || startingId) return;
    if (surveyProgress(field).state !== 'done') return;
    setStartingId(field.id);
    setError(null);
    setWorkerDown(false);
    try {
      const live = await predictionWorkerLive();
      await recordPredictionRequest(field.id);
      const runId = await startPredictionRun(field.id, live ? 'local' : 'github');
      if (!live) {
        try {
          await dispatchNdvi(runId);
        } catch {
          await choosePrediction(runId, 'cancel').catch(() => undefined);
          setWorkerDown(true);
          setStartingId(null);
          return;
        }
      }
      saveRunningPrediction(userId, field.id, runId);
      navigate(`/prediction/fields/${field.id}`);
    } catch (err: unknown) {
      setError(describeError(err, t));
      setStartingId(null);
    }
  };

  const runningField = fields.find((field) => field.id === running?.fieldId);

  return (
    <div className="cf-dashboard flex-1">
      <div className="px-4 sm:px-8 py-6 sm:py-10 max-w-5xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-semibold text-cf-text">{t('prediction.title')}</h1>
          <p className="text-sm sm:text-base text-cf-muted leading-relaxed max-w-2xl">{t('prediction.intro')}</p>
        </div>

        <div className="space-y-3 max-w-2xl">
          <div className="cf-glass-sage rounded-2xl px-5 py-4">
            <p className="text-sm text-cf-text leading-relaxed">{t('prediction.disclaimer')}</p>
          </div>
          <div className="cf-glass-sage rounded-2xl px-5 py-4">
            <p className="text-sm text-cf-text leading-relaxed">{t('prediction.emptyFieldNotice')}</p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-cf-muted">{t('prediction.loading')}</p>
        ) : error ? (
          <p className="text-sm text-red-900" role="alert">{error || t('prediction.loadFailed')}</p>
        ) : (
          <>
            {workerDown && (
              <div className="cf-glass-sage rounded-2xl px-5 py-4 flex gap-3" role="alert">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
                <p className="text-sm text-cf-text leading-relaxed">{t('prediction.workerDown')}</p>
              </div>
            )}

            {!farmReady && (
              <div className="cf-glass-sage rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex gap-3">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
                  <p className="text-sm text-cf-text leading-relaxed">{t('prediction.farmRequired')}</p>
                </div>
                <Link to="/farm-profile" className="cf-btn-primary shrink-0 px-4 py-2.5 rounded-xl text-sm inline-flex items-center justify-center gap-2">
                  {t('prediction.farmAction')}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            )}

            {runningField && (
              <div className="bg-cf-panel border border-cf-border rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-sm text-cf-text leading-relaxed">{t('prediction.running', { name: runningField.name })}</p>
                <Link
                  to={`/prediction/fields/${runningField.id}`}
                  className="cf-btn-secondary shrink-0 px-4 py-2.5 rounded-xl text-sm inline-flex items-center justify-center gap-2"
                >
                  {t('prediction.view')}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            )}

            {fields.length === 0 ? (
              <div className="cf-glass-box rounded-2xl p-8 text-center space-y-4">
                <span className="inline-flex p-3.5 rounded-2xl bg-cf-hero text-cf-primary border border-white/70">
                  <MapPin className="w-7 h-7" />
                </span>
                <p className="text-sm text-cf-muted max-w-md mx-auto leading-relaxed">{t('prediction.noFields')}</p>
                <Link to="/map" className="cf-btn-primary inline-flex px-5 py-3 rounded-xl text-sm items-center gap-2">
                  {t('prediction.noFieldsAction')}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            ) : (
              <ul className="cf-glass-box rounded-2xl overflow-hidden divide-y divide-cf-border">
                {fields.map((field) => {
                  const survey = surveyProgress(field);
                  const ready = survey.state === 'done';
                  const isRunning = running?.fieldId === field.id;
                  const canStart = farmReady && ready && !running && !startingId;
                  return (
                    <li key={field.id} className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-base font-semibold text-cf-text truncate">{field.name}</p>
                        <p className="text-sm text-cf-muted tabular-nums">
                          {t('prediction.area', { value: ha(field.area_ha) })}
                        </p>
                        {ready ? (
                          <p className="text-sm text-cf-primary flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {isRunning ? t('prediction.inProgress') : t('prediction.ready')}
                          </p>
                        ) : (
                          <p className="text-sm text-cf-text flex items-start gap-1.5">
                            <ClipboardList className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
                            <span>
                              {t('prediction.fieldRequired', {
                                answered: String(survey.answered),
                                total: String(survey.total),
                              })}{' '}
                              <Link to={`${fieldPath(field.id)}/questionnaire`} className="text-cf-primary underline underline-offset-2">
                                {t('prediction.fieldAction')}
                              </Link>
                            </span>
                          </p>
                        )}
                      </div>
                      {isRunning ? (
                        <Link
                          to={`/prediction/fields/${field.id}`}
                          className="cf-btn-secondary shrink-0 px-4 py-2.5 rounded-xl text-sm inline-flex items-center justify-center gap-2"
                        >
                          <Sprout className="w-4 h-4 text-cf-primary" />
                          {t('prediction.view')}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled={!canStart}
                          onClick={() => start(field)}
                          className="cf-btn-primary shrink-0 px-4 py-2.5 rounded-xl text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <Sprout className="w-4 h-4" />
                          {t('prediction.predict')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
};

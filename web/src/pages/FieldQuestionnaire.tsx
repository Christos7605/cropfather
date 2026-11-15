import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, CloudRain, Copy, LandPlot, Layers, Loader2, MapPin, Sprout, Tractor } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../context/LanguageContext';
import { describeError } from '../lib/fields';
import {
  FIELD_QUESTIONNAIRE,
  cleanAnswers,
  listCopySources,
  loadFarmResponse,
  loadFieldResponse,
  saveFieldResponse,
  type CopySource,
} from '../lib/questionnaire';
import {
  ErrorBox,
  QuestionnaireWizard,
  secondaryBtn,
  type WizardApi,
} from '../components/questionnaire/QuestionnaireWizard';

interface FieldInfo {
  id: string;
  name: string;
  area_ha: number | null;
}

const SECTION_ICONS = { water: CloudRain, soil: Layers };

export const FieldQuestionnaire: React.FC = () => {
  const { fieldId = '' } = useParams();
  const navigate = useNavigate();
  const { t, locale } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;

  const [field, setField] = useState<FieldInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<CopySource[]>([]);
  const [farmDone, setFarmDone] = useState(true);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const { data, error: err } = await supabase
        .from('my_fields')
        .select('id, name, area_ha')
        .eq('id', fieldId)
        .maybeSingle();
      if (err) throw err;
      if (!data) {
        setState('notFound');
        return;
      }
      setField(data as FieldInfo);
      // Helpers around the questionnaire: failures here only hide them
      const [copy, farm] = await Promise.allSettled([listCopySources(fieldId), loadFarmResponse()]);
      setSources(copy.status === 'fulfilled' ? copy.value : []);
      setFarmDone(farm.status === 'fulfilled' ? farm.value?.status === 'submitted' : true);
      setState('ready');
    } catch (e) {
      setError(describeError(e, tRef.current));
      setState('error');
    }
  }, [fieldId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back to the field page, on its Questionnaire tab
  const fieldLink = `/fields/${encodeURIComponent(fieldId)}?tab=questionnaire`;

  if (state === 'loading') {
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

  if (state !== 'ready' || !field) {
    return (
      <div className="cf-dashboard flex-1">
        <div className="px-4 sm:px-8 py-12 max-w-2xl mx-auto w-full space-y-5">
        <Link to="/dashboard" className="text-sm text-cf-muted hover:text-cf-text inline-flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          {t('field.back')}
        </Link>
        <ErrorBox
          message={state === 'notFound' ? t('fieldQuestionnaire.notFound') : `${t('questionnaire.loadFailed')} ${error ?? ''}`}
          onRetry={state === 'error' ? () => void load() : undefined}
        />
        </div>
      </div>
    );
  }

  return (
    <QuestionnaireWizard
      key={field.id}
      def={FIELD_QUESTIONNAIRE}
      load={() => loadFieldResponse(field.id)}
      save={(answers, status) => saveFieldResponse(field.id, answers, status)}
      icon={ClipboardList}
      sectionIcons={SECTION_ICONS}
      title={t('fieldQuestionnaire.title')}
      intro={t('fieldQuestionnaire.intro')}
      privacy={t('fieldQuestionnaire.privacy')}
      back={{ to: fieldLink, label: t('fieldQuestionnaire.backToField', { name: field.name }) }}
      badge={
        <span className="cf-glass-pill self-start sm:self-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm text-cf-muted shrink-0">
          <MapPin className="w-3.5 h-3.5 text-cf-primary" />
          <span className="font-medium text-cf-text truncate max-w-[12rem]">{field.name}</span>
          {field.area_ha != null && (
            <span className="text-cf-muted tabular-nums">
              ·{' '}
              {t('profile.areaValue', {
                value: field.area_ha.toLocaleString(locale, { maximumFractionDigits: 2 }),
              })}
            </span>
          )}
        </span>
      }
      extras={(api) => (
        <>
          {sources.length > 0 && <CopyFromField sources={sources} api={api} />}
          {!farmDone && (
            <div className="cf-glass-sage rounded-xl px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex gap-3">
                <Tractor className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-cf-text">{t('fieldQuestionnaire.farmPrompt.title')}</p>
                  <p className="text-sm text-cf-muted leading-relaxed">{t('fieldQuestionnaire.farmPrompt.desc')}</p>
                </div>
              </div>
              <Link to="/farm-profile" className={`${secondaryBtn} shrink-0`}>
                {t('fieldQuestionnaire.farmPrompt.start')}
              </Link>
            </div>
          )}
        </>
      )}
      doneDesc={t('fieldQuestionnaire.doneDesc', { name: field.name })}
      doneActions={(review) => (
        <>
          <button
            type="button"
            onClick={() => navigate(`/fields/${encodeURIComponent(field.id)}?tab=history`)}
            className="cf-btn-primary px-5 py-3 rounded-lg text-sm flex items-center justify-center gap-2"
          >
            <Sprout className="w-4 h-4" />
            {t('fieldQuestionnaire.toHistory')}
          </button>
          <button type="button" onClick={() => navigate(fieldLink)} className={secondaryBtn}>
            <LandPlot className="w-4 h-4" />
            {t('fieldQuestionnaire.backToField', { name: field.name })}
          </button>
          <button type="button" onClick={review} className={secondaryBtn}>
            <ClipboardList className="w-4 h-4" />
            {t('questionnaire.review')}
          </button>
        </>
      )}
    />
  );
};

// Copies the answers of another of the farmer's fields into this one
const CopyFromField: React.FC<{ sources: CopySource[]; api: WizardApi }> = ({ sources, api }) => {
  const { t } = useLanguage();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const copy = async () => {
    const source = sources.find((s) => s.id === sourceId);
    if (!source || busy) return;
    if (api.answered > 0 && !window.confirm(t('fieldQuestionnaire.copy.confirm', { name: source.name }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await loadFieldResponse(source.id);
      api.replaceAll(cleanAnswers(FIELD_QUESTIONNAIRE, saved?.answers ?? {}));
      setMessage({ tone: 'ok', text: t('fieldQuestionnaire.copy.done', { name: source.name }) });
    } catch {
      setMessage({ tone: 'error', text: t('fieldQuestionnaire.copy.failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-cf-border bg-cf-hero px-4 sm:px-5 py-3.5 space-y-3">
      <div className="flex gap-3">
        <Copy className="w-4 h-4 mt-0.5 shrink-0 text-cf-primary" aria-hidden="true" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-cf-text">{t('fieldQuestionnaire.copy.title')}</p>
          <p className="text-sm text-cf-muted leading-relaxed">{t('fieldQuestionnaire.copy.desc')}</p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 sm:pl-7">
        <label className="sr-only" htmlFor="fs-copy-source">
          {t('fieldQuestionnaire.copy.label')}
        </label>
        <select
          id="fs-copy-source"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className="flex-1 min-w-0 bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text focus:outline-none focus:border-cf-primary transition-colors cursor-pointer"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void copy()} disabled={busy} className={secondaryBtn}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
          {t('fieldQuestionnaire.copy.button')}
        </button>
      </div>
      {message && (
        <p
          className={`text-sm sm:pl-7 ${message.tone === 'ok' ? 'text-cf-primary' : 'text-red-800'}`}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </div>
  );
};
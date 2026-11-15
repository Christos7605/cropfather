import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardList,
  CloudSun,
  Droplets,
  LandPlot,
  Loader2,
  Map as MapIcon,
  Pencil,
  Ruler,
  Sprout,
  Spline,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  IRRIGATION_OPTIONS,
  deleteField,
  describeError,
  updateFieldDetails,
  type FieldRecord,
  type Irrigation,
} from '../lib/fields';
import {
  fieldPath,
  fieldSteps,
  getMyField,
  listMySeasons,
  missingDepth,
  needsWaterSource,
  surveyProgress,
  type SeasonBrief,
  type Step,
} from '../lib/fieldStatus';
import { cropName, listCrops, type Crop } from '../lib/seasons';
import {
  DEPTH_KINDS,
  FAR_WELL_KM,
  distanceKm,
  linkedWaterPoint,
  parseDepth,
  setFieldWaterSource,
} from '../lib/waterPoints';
import { WELL_COLORS } from '../lib/mapConfig';
import { setPumpDepth } from '../lib/irrigation';
import { confirmLeave } from '../lib/navigationGuard';
import { ErrorBox, secondaryBtn } from '../components/questionnaire/QuestionnaireWizard';
import { SeasonsTab } from '../components/field/SeasonsTab';
import { QuestionnaireTab } from '../components/field/QuestionnaireTab';
import { WeatherPanel } from '../components/field/WeatherPanel';
import { SeasonResultsCard } from '../components/field/SeasonResultsCard';

// One field, everything about it: /fields/:fieldId?tab=overview|weather|history|questionnaire
// Drawing and choosing a water point need the big map, so those buttons open /map with the
// field selected and the tool already started (?field=<id>&action=edit|water)

const FieldsMap = lazy(() => import('../components/field/FieldsMap'));

type Tab = 'overview' | 'weather' | 'history' | 'questionnaire';
const TABS: { id: Tab; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', icon: LandPlot },
  { id: 'weather', icon: CloudSun },
  { id: 'history', icon: Sprout },
  { id: 'questionnaire', icon: ClipboardList },
];

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors';

// The old crop history address now opens the Crop history tab
export const FieldHistoryRedirect: React.FC = () => {
  const { fieldId = '' } = useParams();
  return <Navigate to={fieldPath(fieldId, 'history')} replace />;
};

export const FieldPage: React.FC = () => {
  const { fieldId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, language, locale } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;

  const [field, setField] = useState<FieldRecord | null>(null);
  const [seasons, setSeasons] = useState<SeasonBrief[]>([]);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const rawTab = params.get('tab');
  const tab: Tab = rawTab === 'weather' || rawTab === 'history' || rawTab === 'questionnaire' ? rawTab : 'overview';

  const load = useCallback(async () => {
    setState('loading');
    try {
      const row = await getMyField(fieldId);
      if (!row) {
        setState('notFound');
        return;
      }
      const [seasonList, cropList] = await Promise.all([listMySeasons(fieldId), listCrops()]);
      setField(row);
      setSeasons(seasonList);
      setCrops(cropList);
      setState('ready');
    } catch (err) {
      setLoadError(describeError(err, tRef.current));
      setState('error');
    }
  }, [fieldId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showMessage = (text: string, tone: 'ok' | 'error' = 'ok') => setMessage({ tone, text });

  const goTab = (next: Tab) => {
    if (next === tab || !confirmLeave()) return;
    const p = new URLSearchParams(params);
    p.delete('season'); // a season open in the Crop history tab closes with the tab
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
    setMessage(null);
  };

  const patchField = async (patch: Partial<Pick<FieldRecord, 'name' | 'irrigation'>>, okText: string) => {
    if (!field) return false;
    setBusy(true);
    setMessage(null);
    try {
      await updateFieldDetails(field.id, patch);
      setField({ ...field, ...patch });
      showMessage(okText);
      return true;
    } catch (err) {
      showMessage(describeError(err, t), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!field || !window.confirm(t('profile.confirmDeleteField', { name: field.name }))) return;
    setBusy(true);
    try {
      await deleteField(field.id);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      showMessage(describeError(err, t), 'error');
      setBusy(false);
    }
  };

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops]);

  if (state === 'loading') {
    return (
      <div className="cf-dashboard flex-1">
        <div className="px-4 sm:px-8 py-16 flex justify-center">
          <p className="text-sm text-cf-muted flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('field.loading')}
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
          message={state === 'notFound' ? t('field.notFound') : `${t('field.loadFailed')} ${loadError ?? ''}`}
          onRetry={state === 'error' ? () => void load() : undefined}
        />
      </div>
      </div>
    );
  }

  const ha = (v: number | null) =>
    v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: v < 10 ? 2 : 1, maximumFractionDigits: 2 });
  const mapLink = `/map?field=${encodeURIComponent(field.id)}`;

  return (
    <div className="cf-dashboard flex-1">
    <div className="px-4 sm:px-8 py-6 sm:py-10 max-w-6xl mx-auto w-full space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <Link to="/dashboard" className="text-sm text-cf-muted hover:text-cf-text inline-flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          {t('field.back')}
        </Link>

        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div className="space-y-3 min-w-0">
            <FieldName
              name={field.name}
              busy={busy}
              onSave={(name) => patchField({ name }, t('map.detail.renamed'))}
            />
            <div className="flex flex-wrap gap-2 text-sm">
              <Chip>
                <LandPlot className="w-3.5 h-3.5 text-cf-primary" />
                <span className="tabular-nums">{t('profile.areaValue', { value: ha(field.area_ha) })}</span>
              </Chip>
              <Chip>
                <Droplets className="w-3.5 h-3.5 text-cf-primary" />
                {t(`profile.irrigation.${field.irrigation}`)}
              </Chip>
              {field.kaek && (
                <Chip>
                  <span className="text-cf-muted">{t('map.cadastre.kaek')}</span>
                  <span className="tabular-nums">{field.kaek}</span>
                </Chip>
              )}
            </div>
          </div>
          <Link to={mapLink} className={`${secondaryBtn} shrink-0 self-start md:self-auto`}>
            <MapIcon className="w-4 h-4" />
            {t('field.showOnMap')}
          </Link>
        </div>

        {/* Tabs: the grey baseline sits on the wrapper, outside the scrolling row (a scrolling
            row clips anything drawn below its edge); the active tab draws its own bar inside. */}
        <div className="border-b border-cf-border -mx-4 sm:mx-0">
          <div role="tablist" aria-label={field.name} className="fs-chip-row flex gap-1 overflow-x-auto px-4 sm:px-0">
            {TABS.map(({ id, icon: Icon }) => {
              const active = tab === id;
              const count = id === 'history' ? seasons.length : 0;
              const done = id === 'questionnaire' && surveyProgress(field).state === 'done';
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`fs-tab-${id}`}
                  aria-selected={active}
                  aria-controls={`fs-panel-${id}`}
                  onClick={() => goTab(id)}
                  className={`relative shrink-0 px-3 sm:px-4 pt-3 pb-3.5 rounded-t-lg text-sm flex items-center gap-2 transition-colors cursor-pointer ${
                    active
                      ? 'text-cf-text font-semibold bg-cf-hero/80'
                      : 'text-cf-muted font-medium hover:text-cf-muted hover:bg-cf-hero/45'
                  }`}
                >
                  <Icon className={`hidden sm:inline w-4 h-4 ${active ? 'text-cf-primary' : ''}`} />
                  {t(`field.tabs.${id}`)}
                  {count > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-cf-panel border border-cf-border text-[0.7rem] tabular-nums text-cf-muted">
                      {count}
                    </span>
                  )}
                  {done && <CheckCircle2 className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />}
                  <span
                    aria-hidden="true"
                    className={`absolute left-2 right-2 bottom-0 h-[3px] rounded-full transition-colors ${
                      active ? 'bg-cf-primary' : 'bg-transparent'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-cf-primary' : 'text-red-800'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}

      <div role="tabpanel" id={`fs-panel-${tab}`} aria-labelledby={`fs-tab-${tab}`}>
        {tab === 'overview' && (
          <Overview
            field={field}
            seasons={seasons}
            cropLabel={(id) => cropName(cropById.get(id), language, t('seasons.unknownCrop'))}
            busy={busy}
            onIrrigation={(v) => void patchField({ irrigation: v }, t('map.detail.irrigationSaved'))}
            onFieldUpdate={(row, text) => {
              setField(row);
              showMessage(text);
            }}
            onError={(text) => showMessage(text, 'error')}
            onOpenTab={goTab}
            onDelete={() => void remove()}
          />
        )}
        {tab === 'weather' && (
          <WeatherPanel lat={field.centroid_lat} lon={field.centroid_lon} irrigated={needsWaterSource(field)} />
        )}
        {tab === 'history' && (
          <SeasonsTab
            fieldId={field.id}
            areaHa={field.area_ha}
            field={{
              area_ha: field.area_ha,
              water_point_id: field.water_point_id,
              irrigation: field.irrigation,
              well_depth_m: field.well_depth_m,
              pump_depth_m: field.pump_depth_m ?? null,
            }}
            onChange={(list) =>
              setSeasons(
                list.map((s) => ({
                  field_id: s.field_id,
                  season_year: s.season_year,
                  crop_id: s.crop_id,
                  sown_on: s.sown_on,
                  harvested_on: s.harvested_on,
                })),
              )
            }
          />
        )}
        {tab === 'questionnaire' && <QuestionnaireTab fieldId={field.id} />}
      </div>
    </div>
    </div>
  );
};

// Header pieces
const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cf-panel border border-cf-border text-cf-muted">
    {children}
  </span>
);

const FieldName: React.FC<{ name: string; busy: boolean; onSave: (name: string) => Promise<boolean> }> = ({
  name,
  busy,
  onSave,
}) => {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  useEffect(() => setValue(name), [name]);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    if (await onSave(trimmed)) setEditing(false);
  };

  if (editing) {
    return (
      <form
        className="flex items-center gap-2 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          value={value}
          maxLength={80}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (setEditing(false), setValue(name))}
          aria-label={t('profile.fieldNameAria')}
          className={`${inputCls} text-lg`}
        />
        <button
          type="submit"
          disabled={busy}
          aria-label={t('map.detail.saveName')}
          className="p-2.5 rounded-lg text-cf-primary hover:bg-cf-hero/15 transition-colors cursor-pointer disabled:opacity-50"
        >
          <Check className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setValue(name);
          }}
          aria-label={t('profile.cancelRenameAria')}
          className="p-2.5 rounded-lg text-cf-muted hover:bg-cf-hero transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </form>
    );
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-cf-text break-words min-w-0">{name}</h1>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={t('map.detail.renameAria')}
        className="p-2 rounded-lg text-cf-muted hover:text-cf-text hover:bg-cf-hero transition-colors cursor-pointer shrink-0"
      >
        <Pencil className="w-4 h-4" />
      </button>
    </div>
  );
};

// Overview tab
interface OverviewProps {
  field: FieldRecord;
  seasons: SeasonBrief[];
  cropLabel: (cropId: string) => string;
  busy: boolean;
  onIrrigation: (v: Irrigation) => void;
  onFieldUpdate: (row: FieldRecord, message: string) => void;
  onError: (message: string) => void;
  onOpenTab: (tab: Tab) => void;
  onDelete: () => void;
}

const Overview: React.FC<OverviewProps> = ({
  field,
  seasons,
  cropLabel,
  busy,
  onIrrigation,
  onFieldUpdate,
  onError,
  onOpenTab,
  onDelete,
}) => {
  const { t, locale } = useLanguage();
  const water = linkedWaterPoint(field);
  const fmtInt = (v: number | null) => (v == null ? '–' : Math.round(v).toLocaleString(locale));
  const fmtCoord = (v: number | null) =>
    v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const ha = (v: number | null) =>
    v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: v < 10 ? 2 : 1, maximumFractionDigits: 2 });
  const mapLink = `/map?field=${encodeURIComponent(field.id)}`;

  const steps = fieldSteps(field, seasons);
  const doneCount = steps.filter((s) => s.done).length;
  const survey = surveyProgress(field);
  const latest = seasons[0] ?? null;

  const stepText: Record<Step, { label: string; value: string; action?: React.ReactNode }> = {
    boundary: {
      label: t('field.status.boundary'),
      value:
        field.boundary_source === 'drawn'
          ? t('map.detail.sourceDrawn')
          : t('field.status.boundaryCadastre', { kaek: field.kaek ?? '–' }),
    },
    questionnaire: {
      label: t('fieldQuestionnaire.card.title'),
      value:
        survey.state === 'notStarted'
          ? t('field.status.notStarted')
          : t('field.status.answered', { answered: String(survey.answered), total: String(survey.total) }),
      action: (
        <button type="button" onClick={() => onOpenTab('questionnaire')} className="text-sm text-cf-primary hover:underline cursor-pointer">
          {t('field.status.open')}
        </button>
      ),
    },
    history: {
      label: t('seasons.card.title'),
      value: latest
        ? t('field.status.historyValue', {
            count: String(seasons.length),
            year: String(latest.season_year),
            crop: cropLabel(latest.crop_id),
          })
        : t('seasons.card.none'),
      action: (
        <button type="button" onClick={() => onOpenTab('history')} className="text-sm text-cf-primary hover:underline cursor-pointer">
          {t('field.status.open')}
        </button>
      ),
    },
    water: {
      label: t('map.water.title'),
      value: water ? t('map.wells.code', { code: water.code }) : t('field.status.waterMissing'),
      action: (
        <a href="#fs-water" className="text-sm text-cf-primary hover:underline">
          {t('field.status.open')}
        </a>
      ),
    },
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 items-start">
      {/* Left: the land */}
      <div className="space-y-5">
        <div className="cf-glass-box rounded-2xl overflow-hidden">
          <Suspense fallback={<div className="h-72 sm:h-80 bg-cf-hero/40" />}>
            <FieldsMap
              fields={[{ id: field.id, geometry: field.geometry }]}
              selectedId={field.id}
              label={t('field.mapLabel', { name: field.name })}
              well={
                water && field.centroid_lon != null && field.centroid_lat != null
                  ? { lon: water.lon, lat: water.lat, status: water.status, from: [field.centroid_lon, field.centroid_lat] }
                  : null
              }
              className="h-72 sm:h-80"
            />
          </Suspense>
        </div>

        <div className="cf-glass-box rounded-2xl p-5 sm:p-6 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t('map.review.area')} value={t('profile.areaValue', { value: ha(field.area_ha) })} />
            <Stat label={t('map.review.perimeter')} value={t('map.review.perimeterValue', { value: fmtInt(field.perimeter_m) })} />
          </div>
          <dl className="text-sm space-y-2.5">
            <Row label={t('map.detail.location')}>
              <span className="tabular-nums">
                {fmtCoord(field.centroid_lat)}, {fmtCoord(field.centroid_lon)}
              </span>
            </Row>
            <Row label={t('map.detail.source')}>
              {field.boundary_source === 'cadastre'
                ? t('map.detail.sourceCadastre', { kaek: field.kaek ?? '–' })
                : field.boundary_source === 'cadastre_edited'
                  ? t('map.detail.sourceCadastreEdited', { kaek: field.kaek ?? '–' })
                  : t('map.detail.sourceDrawn')}
            </Row>
            <Row label={t('field.created')}>{fmtDate(field.created_at)}</Row>
            <Row label={t('field.boundaryChanged')}>
              <span className="inline-flex items-center gap-1.5">
                <Ruler className="w-3 h-3 text-cf-muted" aria-hidden="true" />
                {fmtDate(field.geom_updated_at)}
              </span>
            </Row>
          </dl>
          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <Link to={`${mapLink}&action=edit`} className={`${secondaryBtn} flex-1`}>
              <Spline className="w-4 h-4" />
              {t('map.detail.editBoundary')}
            </Link>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="cf-btn-glass-danger flex-1 px-4 py-2.5 rounded-xl text-sm [&_svg]:shrink-0 flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              {t('map.detail.delete')}
            </button>
          </div>
        </div>

        <SeasonResultsCard fieldId={field.id} cropLabel={cropLabel} onOpenHistory={() => onOpenTab('history')} />
      </div>

      {/* Right: what we know about it */}
      <div className="space-y-5">
        <WeatherPanel
          compact
          lat={field.centroid_lat}
          lon={field.centroid_lon}
          irrigated={needsWaterSource(field)}
          onOpenFull={() => onOpenTab('weather')}
        />
        <div className="cf-glass-box rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-cf-text">{t('field.status.title')}</h2>
              <p className="text-sm text-cf-muted leading-relaxed">{t('field.status.desc')}</p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-full bg-cf-panel border border-cf-border text-xs font-medium tabular-nums text-cf-muted">
              {doneCount}/{steps.length}
            </span>
          </div>
          <ul className="divide-y divide-cf-border -my-1">
            {steps.map(({ step, done }) => (
              <li key={step} className="py-3 flex items-center gap-3">
                {done ? (
                  <CheckCircle2 className="w-[18px] h-[18px] text-cf-primary shrink-0" aria-label={t('field.status.done')} />
                ) : (
                  <Circle className="w-[18px] h-[18px] text-cf-primary shrink-0" aria-label={t('field.status.missing')} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-cf-text">{stepText[step].label}</p>
                  <p className="text-xs text-cf-muted truncate">{stepText[step].value}</p>
                </div>
                {stepText[step].action}
              </li>
            ))}
          </ul>
        </div>

        <WaterCard
          field={field}
          busy={busy}
          onIrrigation={onIrrigation}
          onFieldUpdate={onFieldUpdate}
          onError={onError}
        />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-cf-panel border border-cf-border rounded-lg px-3.5 py-3 min-w-0">
    <p className="text-xs text-cf-muted truncate">{label}</p>
    <p className="text-xl font-semibold text-cf-text tabular-nums mt-0.5 truncate">{value}</p>
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex justify-between gap-4">
    <dt className="text-cf-muted shrink-0">{label}</dt>
    <dd className="text-cf-muted text-right min-w-0 break-words">{children}</dd>
  </div>
);

// Water supply and water source
const WaterCard: React.FC<{
  field: FieldRecord;
  busy: boolean;
  onIrrigation: (v: Irrigation) => void;
  onFieldUpdate: (row: FieldRecord, message: string) => void;
  onError: (message: string) => void;
}> = ({ field, busy, onIrrigation, onFieldUpdate, onError }) => {
  const { t, locale } = useLanguage();
  const water = linkedWaterPoint(field);
  const [depth, setDepth] = useState(field.well_depth_m != null ? String(field.well_depth_m) : '');
  const [depthError, setDepthError] = useState<string | null>(null);
  const [pump, setPump] = useState(field.pump_depth_m != null ? String(field.pump_depth_m) : '');
  const [pumpError, setPumpError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDepth(field.well_depth_m != null ? String(field.well_depth_m) : '');
    setDepthError(null);
  }, [field.well_depth_m, field.water_point_id]);

  useEffect(() => {
    setPump(field.pump_depth_m != null ? String(field.pump_depth_m) : '');
    setPumpError(null);
  }, [field.pump_depth_m, field.water_point_id]);

  const distance =
    water && field.centroid_lon != null && field.centroid_lat != null
      ? distanceKm(field.centroid_lon, field.centroid_lat, water.lon, water.lat)
      : null;
  const showsDepth = water ? DEPTH_KINDS.includes(water.kind) : false;
  const savedDepth = field.well_depth_m != null ? String(field.well_depth_m) : '';
  const mapLink = `/map?field=${encodeURIComponent(field.id)}&action=water`;

  const saveDepth = async () => {
    if (!water) return;
    const value = parseDepth(depth);
    if (value !== null && Number.isNaN(value)) {
      setDepthError(t('map.water.depthInvalid'));
      return;
    }
    setSaving(true);
    try {
      const row = await setFieldWaterSource(field.id, water.id, value);
      onFieldUpdate(row, t('field.water.depthSaved'));
    } catch (err) {
      onError(describeError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const savedPump = field.pump_depth_m != null ? String(field.pump_depth_m) : '';
  const savePump = async () => {
    if (!water) return;
    const value = parseDepth(pump);
    if (value !== null && Number.isNaN(value)) {
      setPumpError(t('map.water.depthInvalid'));
      return;
    }
    if (value !== null && field.well_depth_m != null && value > field.well_depth_m) {
      setPumpError(t('field.water.pumpTooDeep', { depth: String(field.well_depth_m) }));
      return;
    }
    setSaving(true);
    try {
      await setPumpDepth(field.id, value);
      const row = await getMyField(field.id);
      if (row) onFieldUpdate(row, t('field.water.pumpSaved'));
    } catch (err) {
      onError(describeError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const removeSource = async () => {
    setSaving(true);
    try {
      const row = await setFieldWaterSource(field.id, null, null);
      onFieldUpdate(row, t('map.water.removed'));
    } catch (err) {
      onError(describeError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="fs-water" className="cf-glass-box rounded-2xl p-5 sm:p-6 space-y-5 scroll-mt-24">
      <div className="flex items-center gap-3">
        <span className="inline-flex p-2 rounded-lg bg-cf-hero/15 text-cf-primary">
          <Waves className="w-4 h-4" />
        </span>
        <h2 className="text-lg font-semibold text-cf-text">{t('field.water.title')}</h2>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="fs-field-irrigation" className="text-sm font-medium text-cf-muted flex items-center gap-1.5">
          <Droplets className="w-3.5 h-3.5 text-cf-primary" />
          {t('map.review.irrigationLabel')}
        </label>
        <select
          id="fs-field-irrigation"
          value={field.irrigation}
          disabled={busy}
          onChange={(e) => onIrrigation(e.target.value as Irrigation)}
          className={`${inputCls} cursor-pointer`}
        >
          {IRRIGATION_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {t(`profile.irrigation.${o}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-cf-panel border border-cf-border rounded-lg px-4 py-3.5 space-y-3">
        <p className="text-sm font-medium text-cf-muted">{t('map.water.title')}</p>
        {water ? (
          <div className="space-y-1">
            <p className="text-sm text-cf-text flex items-center gap-2">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: WELL_COLORS[water.status] }}
                aria-hidden="true"
              />
              {t(`map.wells.kind.${water.kind}`)} · {t(`map.wells.status.${water.status}`)}
            </p>
            <p className="text-xs text-cf-muted tabular-nums">{t('map.wells.code', { code: water.code })}</p>
            {distance !== null && (
              <p className={`text-xs tabular-nums ${distance > FAR_WELL_KM ? 'text-cf-primary' : 'text-cf-muted'}`}>
                {t('map.water.distance', {
                  value: distance.toLocaleString(locale, { maximumFractionDigits: distance < 10 ? 1 : 0 }),
                })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-cf-muted">
            {needsWaterSource(field) ? t('map.water.none') : t('map.water.rainfedNote')}
          </p>
        )}

        {water && showsDepth && (
          <form
            className="space-y-1.5 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDepth();
            }}
          >
            <label htmlFor="fs-field-depth" className="text-sm font-medium text-cf-muted">
              {t('map.water.depthLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id="fs-field-depth"
                inputMode="decimal"
                value={depth}
                onChange={(e) => {
                  setDepth(e.target.value);
                  setDepthError(null);
                }}
                placeholder={t('map.water.depthPlaceholder')}
                className={`${inputCls} tabular-nums`}
                aria-invalid={depthError ? true : undefined}
              />
              <button
                type="submit"
                disabled={saving || depth.trim() === savedDepth}
                className={`${secondaryBtn} shrink-0`}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('field.water.depthSave')}
              </button>
            </div>
            {depthError ? (
              <p className="text-xs text-red-800" role="alert">
                {depthError}
              </p>
            ) : (
              missingDepth(field) && <p className="text-xs text-cf-muted">{t('map.water.depthHint')}</p>
            )}
          </form>
        )}

        {water && showsDepth && (
          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void savePump();
            }}
          >
            <label htmlFor="fs-field-pump" className="text-sm font-medium text-cf-muted">
              {t('field.water.pumpLabel')}
              <span className="ml-1.5 font-normal text-cf-muted">{t('questionnaire.optional')}</span>
            </label>
            <div className="flex gap-2">
              <input
                id="fs-field-pump"
                inputMode="decimal"
                value={pump}
                onChange={(e) => {
                  setPump(e.target.value);
                  setPumpError(null);
                }}
                placeholder={t('field.water.pumpPlaceholder')}
                className={`${inputCls} tabular-nums`}
                aria-invalid={pumpError ? true : undefined}
              />
              <button type="submit" disabled={saving || pump.trim() === savedPump} className={`${secondaryBtn} shrink-0`}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('field.water.depthSave')}
              </button>
            </div>
            {pumpError ? (
              <p className="text-xs text-red-800" role="alert">
                {pumpError}
              </p>
            ) : (
              <p className="text-xs text-cf-muted">{t('field.water.pumpHint')}</p>
            )}
          </form>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <Link to={mapLink} className={`${secondaryBtn} w-full`}>
            <Droplets className="w-4 h-4" />
            {water ? t('field.water.changeOnMap') : t('field.water.chooseOnMap')}
            <ChevronRight className="w-4 h-4" />
          </Link>
          {water && (
            <button type="button" onClick={() => void removeSource()} disabled={saving} className={`${secondaryBtn} w-full`}>
              <X className="w-4 h-4" />
              {t('map.water.remove')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Droplets,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Spline,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  MousePointerClick,
  Ruler,
  Sprout,
  LandPlot,
  Waves,
  ClipboardList,
  ChevronRight,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { IRRIGATION_OPTIONS, errorKeyFor, type FieldRecord, type FieldPreview, type Irrigation } from '../../lib/fields';
import type { BuildingCheck } from './FieldMapCanvas';
import { type ParcelHit } from '../../lib/cadastre';
import { WELL_COLORS } from '../../lib/mapConfig';
import {
  DEPTH_KINDS,
  FAR_WELL_KM,
  WATER_POINTS_ATTRIBUTION,
  distanceKm,
  linkedWaterPoint,
  type WaterPoint,
} from '../../lib/waterPoints';
import { FIELD_QUESTIONNAIRE, countedQuestions } from '../../lib/questionnaire';

// Shared components
const PanelTitle: React.FC<{ icon: React.ReactNode; children: React.ReactNode; tone?: string }> = ({
  icon,
  children,
  tone = 'bg-cf-hero text-cf-primary',
}) => (
  <div className="flex items-center gap-3">
    <span className={`inline-flex p-2 rounded-xl ${tone}`}>{icon}</span>
    <h2 className="text-lg font-semibold text-cf-text">{children}</h2>
  </div>
);

const Notice: React.FC<{ tone: 'ok' | 'warn' | 'error' | 'info'; children: React.ReactNode }> = ({ tone, children }) => {
  const styles = {
    ok: 'bg-cf-hero border-cf-border text-cf-text',
    warn: 'bg-[#F3EBD6] border-[#E3B55B]/50 text-cf-text',
    error: 'bg-red-50 border-red-700/30 text-red-900',
    info: 'bg-cf-bg border-cf-border text-cf-muted',
  }[tone];
  const Icon = { ok: CheckCircle2, warn: AlertTriangle, error: AlertCircle, info: AlertCircle }[tone];
  const iconColor = { ok: 'text-cf-primary', warn: 'text-[#8A6A2F]', error: 'text-red-700', info: 'text-cf-muted' }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={`p-3 rounded-xl border text-sm flex gap-2.5 ${styles}`}>
      <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
      <div className="leading-relaxed">{children}</div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 min-w-0">
    <p className="text-xs text-cf-muted truncate">{label}</p>
    <p className="text-xl font-semibold text-cf-text tabular-nums mt-0.5 truncate">{value}</p>
  </div>
);

const secondaryBtn =
  'cf-btn-glass-sage px-4 py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 text-center disabled:opacity-50 [&_svg]:shrink-0';

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors';

function useFormatters() {
  const { locale } = useLanguage();
  return {
    ha: (v: number | null | undefined) =>
      v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: v < 10 ? 2 : 1, maximumFractionDigits: 2 }),
    int: (v: number | null | undefined) => (v == null ? '–' : Math.round(v).toLocaleString(locale)),
    date: (iso: string) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    coord: (v: number | null) => (v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: 5, maximumFractionDigits: 5 })),
  };
}

// Field list
interface ListProps {
  fields: FieldRecord[];
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  limit: number;
  isAnonymous: boolean;
  canDraw: boolean;
  onAdd: () => void;
  onZoomIn: () => void;
  onSelect: (id: string) => void;
}

export const FieldListPanel: React.FC<ListProps> = ({
  fields,
  loading,
  loadError,
  onRetry,
  limit,
  isAnonymous,
  canDraw,
  onAdd,
  onZoomIn,
  onSelect,
}) => {
  const { t } = useLanguage();
  const fmt = useFormatters();
  const atLimit = fields.length >= limit;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <PanelTitle icon={<MapPin className="w-4 h-4" />}>{t('map.yourFields')}</PanelTitle>
        {!loading && (
          <span className="px-2.5 py-1 rounded-full bg-cf-panel border border-cf-border text-xs text-cf-muted tabular-nums">
            {t('map.fieldCount', { count: String(fields.length), max: String(limit) })}
          </span>
        )}
      </div>

      <div className="space-y-2.5">
        <button
          type="button"
          onClick={onAdd}
          disabled={!canDraw || atLimit || loading}
          className="cf-btn-primary w-full px-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2 [&_svg]:shrink-0"
        >
          <Plus className="w-4 h-4" />
          {t('map.addField')}
        </button>
        {atLimit ? (
          <Notice tone="warn">
            {t('map.limitReached', { max: String(limit) })}
            {isAnonymous && (
              <>
                {' '}
                <Link to="/register" className="text-cf-primary hover:underline">
                  {t('common.createAccount')}
                </Link>
              </>
            )}
          </Notice>
        ) : !canDraw && !loading ? (
          <div className="flex items-center justify-between gap-3 text-sm text-cf-muted bg-cf-panel border border-cf-border rounded-xl px-3.5 py-2.5">
            <span>{t('map.zoomToDraw')}</span>
            <button
              type="button"
              onClick={onZoomIn}
              className="shrink-0 flex items-center gap-1.5 text-cf-primary hover:text-cf-text transition-colors cursor-pointer font-medium"
            >
              <ZoomIn className="w-4 h-4" />
              {t('map.zoomIn')}
            </button>
          </div>
        ) : null}
        {isAnonymous && !atLimit && (
          <p className="text-xs text-cf-muted leading-relaxed">{t('map.guestLimit', { max: String(limit) })}</p>
        )}
        {!atLimit && !loading && (
          <p className="text-xs text-cf-muted leading-relaxed flex gap-2">
            <LandPlot className="w-3.5 h-3.5 shrink-0 mt-0.5 text-cf-primary" aria-hidden="true" />
            <span>{t('map.cadastre.tip')}</span>
          </p>
        )}
      </div>

      {loadError && (
        <Notice tone="error">
          <span>{loadError}</span>{' '}
          <button type="button" onClick={onRetry} className="underline cursor-pointer">
            {t('map.retry')}
          </button>
        </Notice>
      )}

      {loading ? (
        <p className="text-sm text-cf-muted flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('map.loadingFields')}
        </p>
      ) : fields.length === 0 && !loadError ? (
        <div className="bg-cf-panel border border-cf-border rounded-xl p-5 space-y-4">
          <h3 className="font-display font-semibold text-cf-text">{t('map.empty.title')}</h3>
          <ol className="space-y-3.5">
            {[
              { icon: <Search className="w-4 h-4" />, text: t('map.empty.step1') },
              { icon: <ZoomIn className="w-4 h-4" />, text: t('map.empty.step2') },
              { icon: <MousePointerClick className="w-4 h-4" />, text: t('map.empty.step3') },
            ].map((s, i) => (
              <li key={i} className="flex gap-3 text-sm text-cf-muted leading-relaxed">
                <span className="shrink-0 w-7 h-7 rounded-full bg-cf-hero border border-cf-border flex items-center justify-center text-cf-primary">
                  {s.icon}
                </span>
                <span className="pt-0.5">{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <ul className="space-y-2">
          {fields.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onSelect(f.id)}
                className="cf-glass-box w-full text-left rounded-xl px-3.5 py-3 flex items-center gap-3 cursor-pointer group"
              >
                <span className="w-2.5 h-9 rounded-full bg-cf-primary/70 group-hover:bg-cf-primary shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-cf-text truncate">{f.name}</span>
                  <span className="block text-xs text-cf-muted mt-0.5">
                    {t('profile.areaValue', { value: fmt.ha(f.area_ha) })} · {t(`profile.irrigation.${f.irrigation}`)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// Drawing
interface DrawProps {
  areaSoFar: number | null;
  canUndo: boolean;
  onUndo: () => void;
  onCancel: () => void;
}

export const DrawingPanel: React.FC<DrawProps> = ({ areaSoFar, canUndo, onUndo, onCancel }) => {
  const { t } = useLanguage();
  const fmt = useFormatters();
  return (
    <div className="space-y-5">
      <PanelTitle icon={<Spline className="w-4 h-4" />} tone="bg-cf-hero text-cf-primary">
        {t('map.draw.title')}
      </PanelTitle>
      <ol className="space-y-3">
        {[t('map.draw.step1'), t('map.draw.step2')].map((text, i) => (
          <li key={i} className="flex gap-3 text-sm text-cf-muted leading-relaxed">
            <span className="shrink-0 w-6 h-6 rounded-full bg-cf-hero border border-cf-border flex items-center justify-center text-xs font-semibold text-cf-text">
              {i + 1}
            </span>
            <span className="pt-0.5">{text}</span>
          </li>
        ))}
      </ol>
      <Notice tone="info">{t('map.draw.hint')}</Notice>
      {areaSoFar !== null && areaSoFar > 0 && (
        <p className="text-sm text-cf-muted tabular-nums" aria-live="polite">
          {t('map.draw.areaSoFar', { value: fmt.ha(areaSoFar) })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" onClick={onUndo} disabled={!canUndo} className={secondaryBtn}>
          <Undo2 className="w-4 h-4" />
          {t('map.draw.undo')}
        </button>
        <button type="button" onClick={onCancel} className={secondaryBtn}>
          <X className="w-4 h-4" />
          {t('map.draw.cancel')}
        </button>
      </div>
    </div>
  );
};

// Check and save a new field or adjust a boundary
interface ShapeProps {
  isNew: boolean;
  preview: FieldPreview | null;
  checking: boolean;
  previewError: string | null;
  trimmedM2: number | null;
  trimmedParts: boolean;
  buildings: BuildingCheck | null;
  name: string;
  onNameChange: (v: string) => void;
  irrigation: Irrigation;
  onIrrigationChange: (v: Irrigation) => void;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
  onRedraw: () => void;
  onDiscard: () => void;
  // Variable that is set when the boundary started from a Cadastre parcel
  cadastreKaek?: string | null;
  fromCadastre?: boolean;
}

export const ShapePanel: React.FC<ShapeProps> = ({
  isNew,
  preview,
  checking,
  previewError,
  trimmedM2,
  trimmedParts,
  buildings,
  name,
  onNameChange,
  irrigation,
  onIrrigationChange,
  saving,
  saveError,
  onSave,
  onRedraw,
  onDiscard,
  cadastreKaek = null,
  fromCadastre = false,
}) => {
  const { t } = useLanguage();
  const fmt = useFormatters();
  const invalid = preview?.status === 'invalid';
  const invalidKey = invalid ? errorKeyFor(preview?.code) : null;
  const invalidText = invalidKey ? t(invalidKey) : null;
  const canSave = !saving && !checking && !!preview && !invalid && (!isNew || name.trim().length > 0);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave();
      }}
    >
      <PanelTitle icon={<Check className="w-4 h-4" />} tone="bg-cf-hero text-cf-primary">
        {isNew ? t('map.review.newTitle') : t('map.review.editTitle')}
      </PanelTitle>

      {fromCadastre && (
        <Notice tone="info">
          {cadastreKaek
            ? t('map.cadastre.reviewNote', { kaek: cadastreKaek })
            : t('map.cadastre.reviewNoteNoKaek')}
        </Notice>
      )}

      <p className="text-sm text-cf-muted leading-relaxed">{t('map.review.dragHint')}</p>

      <div className="grid grid-cols-2 gap-2.5">
        <Stat
          label={t('map.review.area')}
          value={preview?.area_ha != null ? t('profile.areaValue', { value: fmt.ha(preview.area_ha) }) : '–'}
        />
        <Stat
          label={t('map.review.perimeter')}
          value={preview?.perimeter_m != null ? t('map.review.perimeterValue', { value: fmt.int(preview.perimeter_m) }) : '–'}
        />
      </div>

      <div className="space-y-2.5" aria-live="polite">
        {checking ? (
          <p className="text-sm text-cf-muted flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('map.review.checking')}
          </p>
        ) : previewError ? (
          <Notice tone="error">{previewError}</Notice>
        ) : invalid ? (
          <Notice tone="error">{invalidText ?? preview?.code}</Notice>
        ) : preview ? (
          trimmedM2 === null && <Notice tone="ok">{t('map.review.ok')}</Notice>
        ) : null}
        {trimmedM2 !== null && !checking && (
          <Notice tone="warn">
            {t('map.review.trimmed', { value: fmt.int(trimmedM2) })}
            {trimmedParts && <> {t('map.review.trimmedParts')}</>}
          </Notice>
        )}
        {buildings && buildings.buildings > 0 && (
          <Notice tone="warn">{t('map.review.buildings', { count: String(buildings.buildings) })}</Notice>
        )}
        {buildings && buildings.buildings === 0 && buildings.builtUp && (
          <Notice tone="warn">{t('map.review.builtUp')}</Notice>
        )}
      </div>

      {isNew && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="fs-field-name" className="text-sm font-medium text-cf-muted">
              {t('map.review.nameLabel')}
            </label>
            <input
              id="fs-field-name"
              value={name}
              maxLength={80}
              onChange={(e) => onNameChange(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
          </div>
          <IrrigationSelect id="fs-field-irrigation" value={irrigation} onChange={onIrrigationChange} />
        </div>
      )}

      {saveError && <Notice tone="error">{saveError}</Notice>}

      <div className="space-y-2.5">
        <button
          type="submit"
          disabled={!canSave}
          className="cf-btn-primary w-full px-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2 [&_svg]:shrink-0"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {saving ? t('map.review.saving') : isNew ? t('map.review.save') : t('map.review.saveBoundary')}
        </button>
        <div className={`grid gap-2.5 ${isNew ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {isNew && (
            <button type="button" onClick={onRedraw} disabled={saving} className={secondaryBtn}>
              <RotateCcw className="w-4 h-4" />
              {t('map.review.redraw')}
            </button>
          )}
          <button type="button" onClick={onDiscard} disabled={saving} className={secondaryBtn}>
            <X className="w-4 h-4" />
            {isNew ? t('map.review.discard') : t('common.cancel')}
          </button>
        </div>
      </div>
    </form>
  );
};

const IrrigationSelect: React.FC<{
  id: string;
  value: Irrigation;
  onChange: (v: Irrigation) => void;
  disabled?: boolean;
}> = ({ id, value, onChange, disabled }) => {
  const { t } = useLanguage();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-cf-muted flex items-center gap-1.5">
        <Droplets className="w-3.5 h-3.5 text-cf-primary" />
        {t('map.review.irrigationLabel')}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Irrigation)}
        className={`${inputCls} cursor-pointer`}
      >
        {IRRIGATION_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {t(`profile.irrigation.${o}`)}
          </option>
        ))}
      </select>
    </div>
  );
};

// Field details
interface DetailProps {
  field: FieldRecord;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onRename: (name: string) => Promise<boolean>;
  onIrrigation: (v: Irrigation) => void;
  onEditBoundary: () => void;
  onDelete: () => void;
  onChooseWater: () => void;
}

export const FieldDetailPanel: React.FC<DetailProps> = ({
  field,
  busy,
  error,
  onBack,
  onRename,
  onIrrigation,
  onEditBoundary,
  onDelete,
  onChooseWater,
}) => {
  const { t } = useLanguage();
  const fmt = useFormatters();
  const [editingName, setEditingName] = useState(false);
  const water = linkedWaterPoint(field);
  const [name, setName] = useState(field.name);

  useEffect(() => {
    setName(field.name);
    setEditingName(false);
  }, [field.id, field.name]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === field.name) {
      setEditingName(false);
      setName(field.name);
      return;
    }
    if (await onRename(trimmed)) setEditingName(false);
  };

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-cf-muted hover:text-cf-text flex items-center gap-1.5 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('map.detail.back')}
      </button>

      {editingName ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            aria-label={t('profile.fieldNameAria')}
            className={inputCls}
          />
          <button
            type="submit"
            disabled={busy}
            aria-label={t('map.detail.saveName')}
            className="p-2.5 rounded-xl text-cf-primary hover:bg-cf-hero transition-colors cursor-pointer disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingName(false);
              setName(field.name);
            }}
            aria-label={t('profile.cancelRenameAria')}
            className="p-2.5 rounded-xl text-cf-muted hover:bg-cf-hero transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-xl font-semibold text-cf-text break-words min-w-0">{field.name}</h2>
          <button
            type="button"
            onClick={() => setEditingName(true)}
            aria-label={t('map.detail.renameAria')}
            className="p-2 rounded-xl text-cf-muted hover:text-cf-text hover:bg-cf-hero transition-colors cursor-pointer shrink-0"
          >
            <Pencil className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Stat label={t('map.review.area')} value={t('profile.areaValue', { value: fmt.ha(field.area_ha) })} />
        <Stat
          label={t('map.review.perimeter')}
          value={t('map.review.perimeterValue', { value: fmt.int(field.perimeter_m) })}
        />
      </div>

      <Link
        to={`/fields/${encodeURIComponent(field.id)}`}
        className="cf-btn-primary w-full px-4 py-2.5 rounded-xl text-sm flex items-center justify-center gap-2"
      >
        <LandPlot className="w-4 h-4" />
        {t('map.detail.openPage')}
        <ChevronRight className="w-4 h-4" />
      </Link>

      <IrrigationSelect id="fs-detail-irrigation" value={field.irrigation} onChange={onIrrigation} disabled={busy} />

      <div className="bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 space-y-2.5">
        <p className="text-sm font-medium text-cf-muted flex items-center gap-1.5">
          <Waves className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />
          {t('map.water.title')}
        </p>
        {water ? (
          <div className="space-y-1">
            <p className="text-sm text-cf-text flex items-center gap-2">
              <StatusDot status={water.status} />
              <span>
                {t(`map.wells.kind.${water.kind}`)} · {t(`map.wells.status.${water.status}`)}
              </span>
            </p>
            <p className="text-xs text-cf-muted tabular-nums">{t('map.wells.code', { code: water.code })}</p>
            {DEPTH_KINDS.includes(water.kind) && (
              <p className="text-xs text-cf-muted tabular-nums">
                {field.well_depth_m != null
                  ? t('map.water.depthValue', { value: fmt.int(field.well_depth_m) })
                  : t('map.water.depthMissing')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-cf-muted">
            {field.irrigation === 'rainfed' ? t('map.water.rainfedNote') : t('map.water.none')}
          </p>
        )}
        <button type="button" onClick={onChooseWater} disabled={busy} className={`${secondaryBtn} w-full`}>
          <Droplets className="w-4 h-4" />
          {water ? t('map.water.change') : t('map.water.choose')}
        </button>
      </div>

      <QuestionnaireCard field={field} />

      <HistoryCard field={field} />

      <dl className="text-sm space-y-2 bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3">
        <div className="flex justify-between gap-3">
          <dt className="text-cf-muted">{t('map.detail.location')}</dt>
          <dd className="text-cf-muted tabular-nums text-right">
            {fmt.coord(field.centroid_lat)}, {fmt.coord(field.centroid_lon)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-cf-muted shrink-0">{t('map.detail.source')}</dt>
          <dd className="text-cf-muted text-right">
            {field.boundary_source === 'cadastre'
              ? t('map.detail.sourceCadastre', { kaek: field.kaek ?? '–' })
              : field.boundary_source === 'cadastre_edited'
                ? t('map.detail.sourceCadastreEdited', { kaek: field.kaek ?? '–' })
                : t('map.detail.sourceDrawn')}
          </dd>
        </div>
        <div className="pt-2 border-t border-cf-border text-xs text-cf-muted space-y-1">
          <p>{t('profile.created', { date: fmt.date(field.created_at) })}</p>
          <p className="flex items-center gap-1.5">
            <Ruler className="w-3 h-3" aria-hidden="true" />
            {t('map.detail.updated', { date: fmt.date(field.geom_updated_at) })}
          </p>
        </div>
      </dl>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="space-y-2.5">
        <button type="button" onClick={onEditBoundary} disabled={busy} className={`${secondaryBtn} w-full`}>
          <Spline className="w-4 h-4" />
          {t('map.detail.editBoundary')}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="cf-btn-glass-danger w-full px-4 py-2.5 rounded-xl text-sm [&_svg]:shrink-0 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          {t('map.detail.delete')}
        </button>
      </div>
    </div>
  );
};

// Questionnaire progress for one field
const QuestionnaireCard: React.FC<{ field: FieldRecord }> = ({ field }) => {
  const { t } = useLanguage();
  // Answers to an older question set count as not started for the current one
  const current = field.survey_version === FIELD_QUESTIONNAIRE.version ? field.survey_status : null;
  const totalNow = countedQuestions(FIELD_QUESTIONNAIRE).length;
  const answered = current ? field.survey_answered ?? 0 : 0;
  const total = current ? field.survey_total ?? totalNow : totalNow;
  const percent = total ? Math.round((answered / total) * 100) : 0;
  const to = `/fields/${encodeURIComponent(field.id)}/questionnaire`;

  return (
    <div className="bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-cf-muted flex items-center gap-1.5">
          <ClipboardList className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />
          {t('fieldQuestionnaire.card.title')}
        </p>
        {current === 'submitted' && <CheckCircle2 className="w-4 h-4 text-cf-primary" aria-hidden="true" />}
      </div>

      {current ? (
        <div className="space-y-1.5">
          <p className="text-xs text-cf-muted tabular-nums">
            {current === 'submitted'
              ? t('fieldQuestionnaire.card.submitted', { answered: String(answered), total: String(total) })
              : t('fieldQuestionnaire.card.inProgress', { answered: String(answered), total: String(total) })}
          </p>
          <div className="h-1.5 rounded-full bg-cf-hero overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-cf-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-cf-muted">{t('fieldQuestionnaire.card.notStarted')}</p>
      )}

      <Link to={to} className={`${secondaryBtn} w-full`}>
        {current === 'submitted'
          ? t('fieldQuestionnaire.card.review')
          : current
            ? t('fieldQuestionnaire.card.continue')
            : t('fieldQuestionnaire.card.start')}
        <ChevronRight className="w-4 h-4" />
      </Link>
    </div>
  );
};

// Crop history (seasons) of one field
const HistoryCard: React.FC<{ field: FieldRecord }> = ({ field }) => {
  const { t } = useLanguage();
  const count = field.history_count ?? 0;
  const to = `/fields/${encodeURIComponent(field.id)}?tab=history`;
  return (
    <div className="bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-cf-muted flex items-center gap-1.5">
          <Sprout className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />
          {t('seasons.card.title')}
        </p>
        {count > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-cf-hero border border-cf-border text-xs text-cf-muted tabular-nums">
            {count}
          </span>
        )}
      </div>
      <p className={`text-sm ${count > 0 ? 'text-cf-muted' : 'text-cf-muted'}`}>
        {count > 0 ? t('seasons.card.some', { count: String(count) }) : t('seasons.card.none')}
      </p>
      <Link to={to} className={`${secondaryBtn} w-full`}>
        {count > 0 ? t('seasons.card.edit') : t('seasons.card.add')}
        <ChevronRight className="w-4 h-4" />
      </Link>
    </div>
  );
};

// Cadastre parcel picked on the map
interface ParcelProps {
  loading: boolean;
  hit: ParcelHit | null;
  error: string | null;
  atLimit: boolean;
  limit: number;
  onUse: () => void;
  onClose: () => void;
}

export const ParcelPanel: React.FC<ParcelProps> = ({ loading, hit, error, atLimit, limit, onUse, onClose }) => {
  const { t } = useLanguage();
  const fmt = useFormatters();

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onClose}
        className="text-sm text-cf-muted hover:text-cf-text flex items-center gap-1.5 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('map.detail.back')}
      </button>

      <PanelTitle icon={<LandPlot className="w-4 h-4" />}>
        {t('map.cadastre.panelTitle')}
      </PanelTitle>

      {loading ? (
        <p className="text-sm text-cf-muted flex items-center gap-2" aria-live="polite">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('map.cadastre.loading')}
        </p>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : !hit ? (
        <Notice tone="info">{t('map.cadastre.notFound')}</Notice>
      ) : (
        <>
          <div className="space-y-2.5">
            <Stat label={t('map.cadastre.kaek')} value={hit.kaek ?? '–'} />
            <div className="grid grid-cols-2 gap-2.5">
              <Stat label={t('map.review.area')} value={t('profile.areaValue', { value: fmt.ha(hit.areaHa) })} />
              <Stat
                label={t('map.review.perimeter')}
                value={t('map.review.perimeterValue', { value: fmt.int(hit.perimeterM) })}
              />
            </div>
          </div>
          <p className="text-sm text-cf-muted">{t(`map.cadastre.stage.${hit.stage}`)}</p>
          {hit.hasHoles ? (
            <Notice tone="warn">{t('map.cadastre.holes')}</Notice>
          ) : (
            <Notice tone="info">{t('map.cadastre.note')}</Notice>
          )}
          {atLimit && <Notice tone="warn">{t('map.limitReached', { max: String(limit) })}</Notice>}
        </>
      )}

      <div className="space-y-2.5">
        {hit && !hit.hasHoles && !loading && !error && (
          <button
            type="button"
            onClick={onUse}
            disabled={atLimit}
            className="cf-btn-primary w-full px-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2 [&_svg]:shrink-0"
          >
            <Check className="w-4 h-4" />
            {t('map.cadastre.use')}
          </button>
        )}
        <button type="button" onClick={onClose} className={`${secondaryBtn} w-full`}>
          <X className="w-4 h-4" />
          {t('map.cadastre.close')}
        </button>
      </div>

      <p className="text-xs text-cf-muted">{t('map.cadastre.source')}</p>
    </div>
  );
};

// Choosing a field's water source
export const StatusDot: React.FC<{ status: WaterPoint['status'] }> = ({ status }) => (
  <span
    className="inline-block w-2.5 h-2.5 rounded-full border border-cf-text/25 shrink-0"
    style={{ backgroundColor: WELL_COLORS[status] }}
    aria-hidden="true"
  />
);

interface WellPickProps {
  field: FieldRecord;
  chosen: WaterPoint | null;
  depth: string;
  onDepthChange: (v: string) => void;
  depthError: string | null;
  zoomedOut: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

export const WellPickPanel: React.FC<WellPickProps> = ({
  field,
  chosen,
  depth,
  onDepthChange,
  depthError,
  zoomedOut,
  saving,
  error,
  onSave,
  onRemove,
  onCancel,
}) => {
  const { t, locale } = useLanguage();
  const linked = field.water_point_id != null;
  const km =
    chosen && field.centroid_lon != null && field.centroid_lat != null
      ? distanceKm(field.centroid_lon, field.centroid_lat, chosen.lon, chosen.lat)
      : null;
  const wantsDepth = chosen ? DEPTH_KINDS.includes(chosen.kind) : false;
  const place = chosen ? [chosen.community, chosen.municipality].filter(Boolean).join(', ') : '';

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen && !saving) onSave();
      }}
    >
      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-cf-muted hover:text-cf-text flex items-center gap-1.5 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        {field.name}
      </button>

      <PanelTitle icon={<Droplets className="w-4 h-4" />} tone="bg-cf-hero text-cf-primary">
        {t('map.water.pickTitle')}
      </PanelTitle>

      <p className="text-sm text-cf-muted leading-relaxed">{t('map.water.pickStep', { name: field.name })}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-cf-muted">
        {(['active', 'inactive', 'unknown'] as const).map((st) => (
          <span key={st} className="flex items-center gap-1.5">
            <StatusDot status={st} />
            {t(`map.wells.legend.${st}`)}
          </span>
        ))}
      </div>

      {zoomedOut && <Notice tone="info">{t('map.wells.zoomHint')}</Notice>}

      {chosen ? (
        <div className="bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 space-y-1.5">
          <p className="text-xs text-cf-muted">{t('map.water.chosen')}</p>
          <p className="text-sm text-cf-text font-medium flex items-center gap-2">
            <StatusDot status={chosen.status} />
            {t(`map.wells.kind.${chosen.kind}`)} · {t(`map.wells.status.${chosen.status}`)}
          </p>
          <p className="text-xs text-cf-muted tabular-nums">{t('map.wells.code', { code: chosen.code })}</p>
          {chosen.ownership && (
            <p className="text-xs text-cf-muted">
              {t('map.wells.ownershipLine', { value: t(`map.wells.ownership.${chosen.ownership}`) })}
            </p>
          )}
          {place && <p className="text-xs text-cf-muted">{t('map.wells.placeLine', { value: place })}</p>}
          {km !== null && (
            <p className="text-xs text-cf-muted tabular-nums">
              {t('map.water.distance', {
                value: km.toLocaleString(locale, { maximumFractionDigits: km < 10 ? 1 : 0 }),
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-cf-muted">{t('map.water.noneChosen')}</p>
      )}

      {km !== null && km > FAR_WELL_KM && (
        <Notice tone="warn">{t('map.water.far', { km: String(FAR_WELL_KM) })}</Notice>
      )}

      {chosen && wantsDepth && (
        <div className="space-y-1.5">
          <label htmlFor="fs-well-depth" className="text-sm font-medium text-cf-muted">
            {t('map.water.depthLabel')}
          </label>
          <input
            id="fs-well-depth"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={depth}
            onChange={(e) => onDepthChange(e.target.value)}
            placeholder={t('map.water.depthPlaceholder')}
            aria-invalid={depthError ? true : undefined}
            aria-describedby="fs-well-depth-hint"
            className={`${inputCls} tabular-nums`}
          />
          <p id="fs-well-depth-hint" className={`text-xs ${depthError ? 'text-red-800' : 'text-cf-muted'}`}>
            {depthError ?? t('map.water.depthHint')}
          </p>
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <div className="space-y-2.5">
        <button
          type="submit"
          disabled={!chosen || saving}
          className="cf-btn-primary w-full px-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2 [&_svg]:shrink-0"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {saving ? t('map.review.saving') : t('map.water.save')}
        </button>
        <div className={`grid gap-2.5 ${linked ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {linked && (
            <button type="button" onClick={onRemove} disabled={saving} className={secondaryBtn}>
              <Trash2 className="w-4 h-4" />
              {t('map.water.remove')}
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={saving} className={secondaryBtn}>
            <X className="w-4 h-4" />
            {t('common.cancel')}
          </button>
        </div>
      </div>

      <p className="text-xs text-cf-muted">{WATER_POINTS_ATTRIBUTION}</p>
    </form>
  );
};
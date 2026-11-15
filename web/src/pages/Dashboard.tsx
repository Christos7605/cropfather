import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Droplets,
  Layers,
  Mail,
  MapPin,
  PartyPopper,
  Phone,
  Plus,
  Ruler,
  Smartphone,
  Sprout,
  Tractor,
  Waves,
} from 'lucide-react';
import { InstagramIcon } from '../components/InstagramIcon';
import logo from '../assets/CropFatherLogo_green.png';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { describeError, listMyFields, type FieldRecord } from '../lib/fields';
import {
  buildTodos,
  fieldPath,
  fieldSteps,
  listMySeasons,
  needsWaterSource,
  seasonsOf,
  surveyProgress,
  type SeasonBrief,
  type Todo,
  type TodoKind,
} from '../lib/fieldStatus';
import { FARM_QUESTIONNAIRE, countedQuestions, loadFarmResponse, type QuestionnaireResponse } from '../lib/questionnaire';
import { cropName, listCrops, type Crop } from '../lib/seasons';

// The farmer's control room: totals, their fields (list and map side by side, a field selected
// in one is highlighted in the other), what is still missing, and the farm profile

const FieldsMap = lazy(() => import('../components/field/FieldsMap'));

const TODO_PREVIEW = 5;

export const Dashboard: React.FC = () => {
  const { user, profile, isAnonymous } = useAuth();
  const { t, locale, language } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;

  const [fields, setFields] = useState<FieldRecord[]>([]);
  const [seasons, setSeasons] = useState<SeasonBrief[]>([]);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // undefined: still loading; null: not started
  const [farm, setFarm] = useState<QuestionnaireResponse | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const userId = user?.id ?? null;
  const displayName = isAnonymous ? t('common.guest') : profile?.display_name ?? t('common.farmer');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // RLS limits every query to the signed-in farmer's rows
      const [fieldList, seasonList, cropList] = await Promise.all([listMyFields(), listMySeasons(), listCrops()]);
      setFields(fieldList);
      setSeasons(seasonList);
      setCrops(cropList);
    } catch (err) {
      setError(describeError(err, tRef.current));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    void load();
  }, [userId, load]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadFarmResponse()
      .then((r) => !cancelled && setFarm(r))
      .catch(() => !cancelled && setFarm(null));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops]);
  const cropLabel = useCallback(
    (id: string) => cropName(cropById.get(id), language, t('seasons.unknownCrop')),
    [cropById, language, t],
  );
  const totalHa = fields.reduce((sum, f) => sum + (f.area_ha ?? 0), 0);
  const ha = (v: number | null) =>
    v == null ? '–' : v.toLocaleString(locale, { minimumFractionDigits: v < 10 ? 2 : 1, maximumFractionDigits: 2 });

  const farmTotal = countedQuestions(FARM_QUESTIONNAIRE).length;
  const farmAnswered = farm?.answered_count ?? 0;
  const farmPercent = farmTotal ? Math.round((farmAnswered / farmTotal) * 100) : 0;
  const farmDone = farm?.status === 'submitted';

  // Next steps wait for the farm profile too, so the list does not jump while it loads
  const todos = useMemo(
    () => (loading || farm === undefined || error ? [] : buildTodos(fields, seasons, farmDone)),
    [loading, farm, error, fields, seasons, farmDone],
  );

  const describe = useCallback(
    (id: string) => {
      const field = fields.find((f) => f.id === id);
      if (!field) return null;
      const last = seasonsOf(seasons, id)[0];
      return {
        title: field.name,
        lines: [
          t('profile.areaValue', { value: ha(field.area_ha) }),
          last ? t('dashboard.row.seasonValue', { year: String(last.season_year), crop: cropLabel(last.crop_id) }) : t('dashboard.noCrop'),
        ],
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, seasons, cropLabel, t, locale],
  );

  return (
    <div className="cf-dashboard flex-1 flex flex-col justify-between selection:bg-cf-hero selection:text-cf-text">
      <div className="px-4 sm:px-8 xl:px-12 py-6 lg:py-8 max-w-[1440px] mx-auto w-full space-y-6 lg:space-y-8">
        {/* Soft Sage Frosted Welcome & Totals Hero */}
        <section className="relative rounded-3xl bg-cf-hero/85 border border-white/80 shadow-[0_20px_50px_-18px_rgba(27,41,33,0.1)] p-6 sm:p-8 lg:p-10 space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1.5">
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight text-cf-text text-balance">
                {t('dashboard.welcome', { name: displayName })}
              </h1>
              <p className="text-sm sm:text-base text-cf-muted leading-relaxed max-w-2xl">
                {isAnonymous ? t('dashboard.guestIntro') : t('dashboard.farmerIntro')}
              </p>
            </div>

            {isAnonymous && (
              <div className="cf-glass-box p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center gap-3.5 text-sm lg:max-w-md">
                <span className="text-cf-muted leading-snug">{t('dashboard.guestBanner')}</span>
                <Link to="/register" className="cf-btn-primary px-4 py-2.5 rounded-xl shrink-0 text-center">
                  {t('common.createAccount')}
                </Link>
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="cf-glass-box p-3.5 border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 text-red-700" />
              <span>{t('dashboard.loadError', { message: error })}</span>
            </div>
          )}

          {/* Totals inside the hero */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5">
            <StatCard
              icon={<Layers className="w-5 h-5" />}
              tone="bg-cf-hero text-cf-primary border border-white/70"
              value={loading ? '...' : String(fields.length)}
              label={t('dashboard.fields')}
            />
            <StatCard
              icon={<MapPin className="w-5 h-5" />}
              tone="bg-cf-hero text-cf-primary border border-white/70"
              value={loading ? '...' : totalHa.toLocaleString(locale, { maximumFractionDigits: 1 })}
              label={t('dashboard.hectares')}
            />
            <StatCard
              icon={<Calendar className="w-5 h-5" />}
              tone="bg-cf-hero text-cf-primary border border-white/70"
              value={loading ? '...' : String(seasons.length)}
              label={t('dashboard.pastCrops')}
            />
          </div>
        </section>

        {/* My fields: list and map */}
        <section className="space-y-4" aria-labelledby="fs-my-fields">
          <div className="flex items-center justify-between gap-4">
            <h2 id="fs-my-fields" className="text-xl font-semibold text-cf-text">
              {t('dashboard.myFields')}
            </h2>
            <div className="flex items-center gap-2">
              <Link
                to="/prediction"
                className="cf-btn-secondary px-3.5 py-2 rounded-xl text-sm inline-flex items-center gap-1.5"
              >
                {t('prediction.open')}
                <ChevronRight className="w-4 h-4" />
              </Link>
              <Link
                to="/map"
                className="cf-btn-secondary px-3.5 py-2 rounded-xl text-sm inline-flex items-center gap-1.5"
              >
                {t('dashboard.mapButton')}
                <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="cf-glass-box rounded-2xl h-80 animate-pulse" />
              <div className="cf-glass-box rounded-2xl h-80 animate-pulse" />
            </div>
          ) : fields.length === 0 ? (
            <div className="cf-glass-box rounded-2xl p-8 sm:p-12 text-center space-y-4">
              <span className="inline-flex p-3.5 rounded-2xl bg-cf-hero text-cf-primary border border-white/70">
                <MapPin className="w-7 h-7" />
              </span>
              <div className="space-y-1.5">
                <h3 className="text-lg font-semibold text-cf-text">{t('dashboard.noFields.title')}</h3>
                <p className="text-sm text-cf-muted max-w-md mx-auto leading-relaxed">{t('dashboard.noFields.desc')}</p>
              </div>
              <Link to="/map" className="cf-btn-primary inline-flex px-5 py-3 rounded-xl text-sm items-center gap-2">
                <Plus className="w-4 h-4" />
                {t('dashboard.noFields.button')}
              </Link>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
                <FieldList
                  fields={fields}
                  seasons={seasons}
                  cropLabel={cropLabel}
                  selectedId={selectedId}
                  onToggle={(id) => setSelectedId((cur) => (cur === id ? null : id))}
                  totalHa={ha(totalHa)}
                  ha={ha}
                />
                <div className="cf-glass-box rounded-2xl p-2 overflow-hidden">
                  <div className="rounded-xl overflow-hidden h-full border border-white/70">
                    <Suspense fallback={<div className="h-72 sm:h-80 lg:h-full lg:min-h-[20rem] bg-cf-hero/40" />}>
                      <FieldsMap
                        fields={fields}
                        selectedId={selectedId}
                        onSelect={(id) => setSelectedId(id)}
                        describe={describe}
                        label={t('dashboard.mapLabel')}
                        className="h-72 sm:h-80 lg:h-full lg:min-h-[20rem]"
                      />
                    </Suspense>
                  </div>
                </div>
              </div>
              <p className="text-xs text-cf-muted">{t('dashboard.mapHint')}</p>
            </>
          )}
        </section>

        {/* Next steps and farm profile */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-8">
            <NextSteps todos={todos} loading={loading || farm === undefined} />
          </div>

          <div className="cf-glass-box lg:col-span-4 p-6 rounded-2xl space-y-4">
            <div className="flex gap-4">
              <div className="inline-flex p-2.5 h-fit rounded-xl bg-cf-hero text-cf-primary border border-white/70 shrink-0">
                <Tractor className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2">
                  {t('farmProfile.card.title')}
                  {farmDone && <CheckCircle2 className="w-4 h-4 text-cf-primary" aria-hidden="true" />}
                </h2>
                {farm ? (
                  <div className="space-y-2">
                    <p className="text-sm text-cf-muted tabular-nums">
                      {farmDone
                        ? t('farmProfile.card.submitted', { answered: String(farmAnswered), total: String(farmTotal) })
                        : t('farmProfile.card.inProgress', { answered: String(farmAnswered), total: String(farmTotal) })}
                    </p>
                    <div className="h-2 rounded-full bg-cf-hero/70 overflow-hidden border border-white/60" aria-hidden="true">
                      <div className="h-full rounded-full bg-cf-primary" style={{ width: `${farmPercent}%` }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-cf-muted leading-relaxed">{t('farmProfile.card.notStarted')}</p>
                )}
              </div>
            </div>
            <Link
              to="/farm-profile"
              className={`w-full px-5 py-3 rounded-xl text-sm flex items-center justify-center gap-2 ${
                farm ? 'cf-btn-secondary' : 'cf-btn-primary'
              }`}
            >
              {farmDone ? t('farmProfile.card.review') : farm ? t('farmProfile.card.continue') : t('farmProfile.card.start')}
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>

      {/* Comprehensive Paperwork & Contact Footer (Non-functional showcase items) */}
      <footer className="cf-glass border-t mt-8 px-4 sm:px-8 xl:px-12 pt-10 pb-6 text-xs text-cf-muted">
        <div className="max-w-[1440px] mx-auto space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-8 pb-8 border-b border-cf-border">
            <div className="lg:col-span-4 space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="cf-glass-pill p-1.5 rounded-lg">
                  <img src={logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
                </div>
                <span className="cf-brand-title text-base text-cf-text">{t('footer.brand')}</span>
              </div>
              <p className="text-xs text-cf-muted leading-relaxed max-w-sm">
                {t('footer.blurb')}
              </p>
              <div className="pt-1 flex flex-wrap items-center gap-2">
                <span className="cf-glass-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-cf-text cursor-default">
                  <Smartphone className="w-3.5 h-3.5 text-cf-primary" />
                  <span>{t('footer.appLink')}</span>
                </span>
              </div>
            </div>

            <div className="lg:col-span-3 space-y-2.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-cf-text">{t('footer.contactTitle')}</h4>
              <ul className="space-y-2">
                <li className="flex items-center gap-2">
                  <Phone className="w-3.5 h-3.5 text-cf-primary shrink-0" />
                  <span className="text-cf-text font-medium select-all">{t('footer.phone')}</span>
                </li>
                <li className="flex items-center gap-2">
                  <Mail className="w-3.5 h-3.5 text-cf-primary shrink-0" />
                  <span className="text-cf-text font-medium select-all">{t('footer.email')}</span>
                </li>
                <li className="flex items-center gap-2">
                  <InstagramIcon className="w-3.5 h-3.5 text-cf-primary shrink-0" />
                  <a
                    href={t('footer.instagramUrl')}
                    className="text-cf-text font-medium hover:text-cf-primary transition-colors"
                  >
                    {t('footer.instagram')}
                  </a>
                </li>
                <li className="text-cf-muted pt-0.5">
                  {t('footer.regions')}
                </li>
              </ul>
            </div>

            <div className="lg:col-span-2 space-y-2.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-cf-text">{t('footer.platformTitle')}</h4>
              <ul className="space-y-1.5">
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.faq')}</span></li>
                <li>
                  <a href="/presentation.pptx" className="hover:text-cf-text transition-colors">
                    {t('footer.presentation')}
                  </a>
                </li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.cadastre')}</span></li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.apiDocs')}</span></li>
              </ul>
            </div>

            <div className="lg:col-span-3 space-y-2.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-cf-text">{t('footer.legalTitle')}</h4>
              <ul className="space-y-1.5">
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.terms')}</span></li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.privacy')}</span></li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.cookies')}</span></li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.openData')}</span></li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-cf-muted">
            <p>{t('footer.copyright')}</p>
            <div className="flex flex-wrap items-center gap-4">
              <span className="cursor-default">{t('footer.iso')}</span>
              <span>·</span>
              <span className="cursor-default">{t('footer.cap')}</span>
              <span>·</span>
              <span className="cursor-default">{t('footer.version')}</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

const StatCard: React.FC<{ icon: React.ReactNode; tone: string; value: string; label: string }> = ({
  icon,
  tone,
  value,
  label,
}) => (
  <div className="cf-glass-box p-5 sm:p-6 rounded-2xl flex items-center gap-4">
    <div className={`inline-flex p-3 rounded-xl shrink-0 ${tone}`}>{icon}</div>
    <div>
      <p className="text-2xl sm:text-3xl font-semibold text-cf-text tabular-nums leading-tight">{value}</p>
      <p className="text-xs sm:text-sm text-cf-muted mt-0.5">{label}</p>
    </div>
  </div>
);

// Field list: one row per field; the selected row opens with its summary
interface ListProps {
  fields: FieldRecord[];
  seasons: SeasonBrief[];
  cropLabel: (id: string) => string;
  selectedId: string | null;
  onToggle: (id: string) => void;
  totalHa: string;
  ha: (v: number | null) => string;
}

const FieldList: React.FC<ListProps> = ({ fields, seasons, cropLabel, selectedId, onToggle, totalHa, ha }) => {
  const { t } = useLanguage();
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // A field picked on the map: bring its row into view
  useEffect(() => {
    if (selectedId) rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <div className="cf-glass-box rounded-2xl overflow-hidden flex flex-col">
      <div className="px-4 sm:px-5 py-3 border-b border-cf-border grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] gap-3 text-xs font-semibold text-cf-muted">
        <span>{t('dashboard.columnName')}</span>
        <span>{t('dashboard.columnCrop')}</span>
        <span className="text-right w-20">{t('dashboard.columnArea')}</span>
      </div>
      <ul className="flex-1 overflow-y-auto max-h-[26rem] divide-y divide-cf-border">
        {fields.map((field) => {
          const open = field.id === selectedId;
          const last = seasonsOf(seasons, field.id)[0];
          return (
            <li
              key={field.id}
              ref={(el) => {
                if (el) rowRefs.current.set(field.id, el);
                else rowRefs.current.delete(field.id);
              }}
              className={open ? 'bg-cf-hero/65' : ''}
            >
              <button
                type="button"
                onClick={() => onToggle(field.id)}
                aria-expanded={open}
                className={`w-full px-4 sm:px-5 py-3.5 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] gap-3 items-center text-left text-sm transition-colors cursor-pointer border-l-3 ${
                  open ? 'border-cf-primary' : 'border-transparent hover:bg-white/40'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <ChevronDown
                    className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180 text-cf-primary' : 'text-cf-muted'}`}
                    aria-hidden="true"
                  />
                  <span className={`truncate font-medium ${open ? 'text-cf-primary font-semibold' : 'text-cf-text'}`}>{field.name}</span>
                </span>
                <span className={`truncate ${last ? 'text-cf-text' : 'text-cf-muted'}`}>
                  {last ? cropLabel(last.crop_id) : t('dashboard.noCrop')}
                </span>
                <span className="text-right w-20 tabular-nums text-cf-muted font-medium">{t('profile.areaValue', { value: ha(field.area_ha) })}</span>
              </button>
              {open && <FieldSummary field={field} seasons={seasons} cropLabel={cropLabel} />}
            </li>
          );
        })}
      </ul>
      <div className="px-4 sm:px-5 py-3 border-t border-cf-border bg-white/40 flex justify-end gap-3 text-sm">
        <span className="text-cf-muted">{t('dashboard.totalArea')}</span>
        <span className="font-semibold text-cf-text tabular-nums">{t('profile.areaValue', { value: totalHa })}</span>
      </div>
    </div>
  );
};

const FieldSummary: React.FC<{ field: FieldRecord; seasons: SeasonBrief[]; cropLabel: (id: string) => string }> = ({
  field,
  seasons,
  cropLabel,
}) => {
  const { t } = useLanguage();
  const last = seasonsOf(seasons, field.id)[0];
  const survey = surveyProgress(field);
  const steps = fieldSteps(field, seasons);
  const done = steps.filter((s) => s.done).length;

  const items: { icon: React.ReactNode; label: string; value: string; ok: boolean }[] = [
    {
      icon: <Droplets className="w-3.5 h-3.5 text-cf-primary" />,
      label: t('dashboard.row.water'),
      value: t(`profile.irrigation.${field.irrigation}`),
      ok: true,
    },
    {
      icon: <Sprout className="w-3.5 h-3.5 text-cf-primary" />,
      label: t('dashboard.row.season'),
      value: last
        ? t('dashboard.row.seasonValue', { year: String(last.season_year), crop: cropLabel(last.crop_id) })
        : t('dashboard.row.seasonNone'),
      ok: steps.find((s) => s.step === 'history')?.done ?? false,
    },
    {
      icon: <ClipboardList className="w-3.5 h-3.5 text-cf-primary" />,
      label: t('dashboard.row.questionnaire'),
      value:
        survey.state === 'notStarted'
          ? t('dashboard.row.questionnaireNone')
          : t('dashboard.row.questionnaireValue', { answered: String(survey.answered), total: String(survey.total) }),
      ok: survey.state === 'done',
    },
    {
      icon: <Waves className="w-3.5 h-3.5 text-cf-primary" />,
      label: t('dashboard.row.waterSource'),
      value: field.water_point_id
        ? t('dashboard.row.waterLinked', { code: field.well_code ?? '–' })
        : needsWaterSource(field)
          ? t('dashboard.row.waterMissing')
          : t('dashboard.row.waterNotNeeded'),
      ok: field.water_point_id != null || !needsWaterSource(field),
    },
  ];

  return (
    <div className="px-4 sm:px-5 pb-4 pt-1 space-y-3.5 border-l-3 border-cf-primary">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((it) => (
          <div key={it.label} className="cf-glass-pill rounded-xl px-3 py-2.5 min-w-0">
            <dt className="text-xs text-cf-muted flex items-center gap-1.5">
              {it.icon}
              {it.label}
            </dt>
            <dd className={`text-sm mt-0.5 truncate font-medium ${it.ok ? 'text-cf-text' : 'text-cf-muted'}`}>{it.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <span className="text-xs text-cf-muted inline-flex items-center gap-1.5 tabular-nums font-medium">
          <Ruler className="w-3.5 h-3.5 text-cf-primary" aria-hidden="true" />
          {t('dashboard.completeness', { done: String(done), total: String(steps.length) })}
        </span>
        <Link
          to={fieldPath(field.id)}
          className="cf-btn-primary px-5 py-2.5 rounded-xl text-sm flex items-center justify-center gap-2"
        >
          {t('dashboard.viewDetails')}
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
};

// Next steps
const TODO_ICON: Record<TodoKind, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  farmProfile: { icon: Tractor, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  firstField: { icon: MapPin, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  waterSource: { icon: Waves, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  questionnaireStart: { icon: ClipboardList, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  questionnaireContinue: { icon: ClipboardList, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  firstSeason: { icon: Sprout, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  latestSeason: { icon: Sprout, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  seasonDates: { icon: Calendar, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
  wellDepth: { icon: Droplets, tone: 'bg-cf-hero text-cf-primary border border-white/70' },
};

const NextSteps: React.FC<{ todos: Todo[]; loading: boolean }> = ({ todos, loading }) => {
  const { t } = useLanguage();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? todos : todos.slice(0, TODO_PREVIEW);

  const text = (todo: Todo) => {
    const vars = {
      year: String(todo.year ?? ''),
      answered: String(todo.answered ?? ''),
      total: String(todo.total ?? ''),
    };
    return { title: t(`dashboard.todo.${todo.kind}`, vars), desc: t(`dashboard.todo.${todo.kind}Desc`, vars) };
  };

  return (
    <section className="cf-glass-box rounded-2xl overflow-hidden" aria-labelledby="fs-next-steps">
      <header className="px-5 sm:px-6 pt-5 pb-4 space-y-1">
        <h2 id="fs-next-steps" className="text-lg font-semibold text-cf-text flex items-center gap-2">
          {t('dashboard.todo.title')}
          {!loading && todos.length > 0 && (
            <span className="cf-glass-pill px-2.5 py-0.5 rounded-full text-xs font-semibold text-cf-primary tabular-nums">
              {todos.length}
            </span>
          )}
        </h2>
        <p className="text-sm text-cf-muted">{t('dashboard.todo.desc')}</p>
      </header>

      {loading ? (
        <div className="px-5 sm:px-6 pb-5 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-xl bg-cf-hero/40 animate-pulse" />
          ))}
        </div>
      ) : todos.length === 0 ? (
        <p className="px-5 sm:px-6 pb-6 text-sm text-cf-muted flex items-center gap-2.5">
          <PartyPopper className="w-4 h-4 text-cf-primary shrink-0" aria-hidden="true" />
          {t('dashboard.todo.allDone')}
        </p>
      ) : (
        <>
          <ul className="border-t border-cf-border divide-y divide-cf-border">
            {shown.map((todo, i) => {
              const { icon: Icon, tone } = TODO_ICON[todo.kind];
              const { title, desc } = text(todo);
              return (
                <li key={`${todo.kind}-${todo.field?.id ?? i}`}>
                  <Link to={todo.to} className="px-5 sm:px-6 py-3.5 flex items-center gap-3.5 hover:bg-white/45 transition-colors group">
                    <span className={`inline-flex p-2 rounded-xl shrink-0 ${tone}`}>
                      <Icon className="w-4 h-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-cf-text">
                        {title}
                        {todo.field && <span className="text-cf-muted font-normal"> · {todo.field.name}</span>}
                      </span>
                      <span className="block text-xs text-cf-muted truncate">{desc}</span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-cf-muted group-hover:text-cf-primary shrink-0 transition-colors" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {todos.length > TODO_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full px-5 py-3 border-t border-cf-border text-sm font-medium text-cf-muted hover:text-cf-text hover:bg-white/45 transition-colors cursor-pointer"
            >
              {showAll ? t('dashboard.todo.showLess') : t('dashboard.todo.showAll', { count: String(todos.length) })}
            </button>
          )}
        </>
      )}
    </section>
  );
};

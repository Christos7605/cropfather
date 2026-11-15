import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { MessageKey } from '../i18n/en';
import { MapPin, Calendar, Database, ShieldCheck, User, Pencil, Trash2, Check, X, AlertCircle, ArrowRight } from 'lucide-react';

interface FieldRecord {
  id: string;
  name: string;
  area_ha: number | null;
  irrigation: string;
  created_at: string;
}

interface CropHistoryRecord {
  id: number;
  season_year: number;
  crop_id: string;
  source: string;
  field_id: string;
  fields: { name: string } | null;
  crops: { name_en: string | null; name_el: string | null } | null;
}

type Message = { type: 'ok' | 'error'; text: string } | null;

const inputClass =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted hover:border-cf-border-strong focus:outline-none focus:border-cf-primary transition-colors';

export const Profile: React.FC = () => {
  const { user, profile, isAnonymous, updateProfile, deleteAccount } = useAuth();
  const { t, translateError, language, setLanguage, locale } = useLanguage();
  const navigate = useNavigate();

  const [fields, setFields] = useState<FieldRecord[]>([]);
  const [cropHistory, setCropHistory] = useState<CropHistoryRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [nameInput, setNameInput] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<Message>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [showDelete, setShowDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const userId = user?.id ?? null;

  // Keep the name field in sync with the saved name (not with language changes)
  const savedName = profile?.display_name ?? '';
  useEffect(() => {
    setNameInput(savedName);
  }, [savedName]);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        // RLS already restricts every query to the signed-in user's rows
        const { data: fieldsData, error: fieldsError } = await supabase
          .from('fields')
          .select('id, name, area_ha, irrigation, created_at')
          .order('created_at', { ascending: false });
        if (fieldsError) throw fieldsError;

        const { data: historyData, error: historyError } = await supabase
          .from('crop_history')
          .select('id, season_year, crop_id, source, field_id, fields(name), crops(name_en, name_el)')
          .order('season_year', { ascending: false });
        if (historyError) throw historyError;

        if (!cancelled) {
          setFields((fieldsData ?? []) as FieldRecord[]);
          setCropHistory((historyData ?? []) as unknown as CropHistoryRecord[]);
          setError(null);
        }
      } catch (err) {
        console.error('Error fetching farmer profile data:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : t('profile.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileMsg(null);
    const name = nameInput.trim();
    if (!name) {
      setProfileMsg({ type: 'error', text: t('profile.nameEmpty') });
      return;
    }
    setSavingProfile(true);
    const { error: saveError } = await updateProfile({ display_name: name });
    setSavingProfile(false);
    setProfileMsg(saveError ? { type: 'error', text: translateError(saveError) } : { type: 'ok', text: t('profile.saved') });
  };

  const startRename = (field: FieldRecord) => {
    setRenamingId(field.id);
    setRenameValue(field.name);
  };

  const saveRename = async (fieldId: string) => {
    const name = renameValue.trim();
    if (!name) return;
    const { error: renameError } = await supabase.from('fields').update({ name }).eq('id', fieldId);
    if (renameError) {
      setError(renameError.message);
      return;
    }
    setFields((prev) => prev.map((f) => (f.id === fieldId ? { ...f, name } : f)));
    setCropHistory((prev) =>
      prev.map((h) => (h.field_id === fieldId && h.fields ? { ...h, fields: { name } } : h))
    );
    setRenamingId(null);
    setError(null);
  };

  const handleDeleteField = async (field: FieldRecord) => {
    if (!window.confirm(t('profile.confirmDeleteField', { name: field.name }))) return;
    const { error: deleteError } = await supabase.from('fields').delete().eq('id', field.id);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setFields((prev) => prev.filter((f) => f.id !== field.id));
    setCropHistory((prev) => prev.filter((h) => h.field_id !== field.id));
    setError(null);
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    const { error: accountError } = await deleteAccount();
    setDeleting(false);
    if (accountError) {
      setError(accountError.message);
      return;
    }
    navigate('/', { replace: true });
  };

  const cropLabel = (h: CropHistoryRecord) =>
    (language === 'el' ? h.crops?.name_el : h.crops?.name_en) ?? h.crops?.name_en ?? h.crop_id;

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'farmer':
        return t('profile.source.farmer');
      case 'worldcereal':
        return t('profile.source.worldcereal');
      case 'cdl':
        return t('profile.source.cdl');
      case 'ndvi':
        return t('profile.source.ndvi');
      default:
        return source;
    }
  };

  return (
    <div className="cf-dashboard flex-1">
    <div className="px-4 sm:px-8 py-8 sm:py-12 max-w-4xl mx-auto w-full space-y-6">
      {error && (
        <div
          role="alert"
          className="cf-glass-box p-3.5 border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 text-red-700" />
          <span>{error}</span>
        </div>
      )}

      {/* Account */}
      <div className="cf-glass-box p-6 sm:p-7 rounded-2xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="inline-flex p-3.5 rounded-xl bg-cf-hero text-cf-primary border border-white/70 shrink-0">
              <User className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-cf-text truncate">
                {isAnonymous ? t('common.guest') : profile?.display_name ?? t('common.farmer')}
              </h1>
              <p className="text-sm text-cf-muted truncate">{isAnonymous ? t('profile.guestAccount') : user?.email}</p>
            </div>
          </div>
          <div className="cf-glass-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-cf-text shrink-0">
            <ShieldCheck className="w-4 h-4 text-cf-primary" />
            <span>{t('profile.private')}</span>
          </div>
        </div>

        {!isAnonymous && (
          <form onSubmit={handleSaveProfile} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end pt-6 border-t border-cf-border">
            <div className="sm:col-span-2">
              <label htmlFor="profile-name" className="block text-sm font-medium text-cf-muted mb-1.5">
                {t('common.yourName')}
              </label>
              <input
                id="profile-name"
                type="text"
                required
                maxLength={80}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="profile-language" className="block text-sm font-medium text-cf-muted mb-1.5">
                {t('common.language')}
              </label>
              <select
                id="profile-language"
                value={language}
                onChange={(e) => setLanguage(e.target.value === 'en' ? 'en' : 'el')}
                className={inputClass}
              >
                <option value="el">Ελληνικά</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="sm:col-span-3 flex items-center gap-4">
              <button
                type="submit"
                disabled={savingProfile}
                className="cf-btn-primary px-5 py-2.5 rounded-xl text-sm"
              >
                {savingProfile ? t('profile.saving') : t('profile.save')}
              </button>
              {profileMsg && (
                <span
                  role="status"
                  className={profileMsg.type === 'ok' ? 'text-sm text-cf-primary' : 'text-sm text-red-800'}
                >
                  {profileMsg.text}
                </span>
              )}
            </div>
          </form>
        )}
      </div>

      {/* Fields */}
      <div className="cf-glass-box p-6 sm:p-7 rounded-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="inline-flex p-2.5 rounded-xl bg-cf-hero text-cf-primary border border-white/70">
            <MapPin className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-semibold text-cf-text">{t('profile.fieldsTitle', { count: fields.length })}</h2>
        </div>

        {loading ? (
          <p className="text-sm text-cf-muted">{t('profile.loadingFields')}</p>
        ) : fields.length === 0 ? (
          <p className="text-sm text-cf-muted leading-relaxed">
            {t('profile.noFields')}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map((field) => (
              <div
                key={field.id}
                className="group relative bg-cf-panel border border-cf-border p-4 rounded-xl space-y-2.5"
              >
                {/* The whole card opens the field page; rename and delete sit above this link */}
                {renamingId !== field.id && (
                  <Link
                    to={`/fields/${encodeURIComponent(field.id)}`}
                    aria-label={t('profile.openField', { name: field.name })}
                    className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-cf-primary"
                  />
                )}
                <div className="flex justify-between items-center gap-2">
                  {renamingId === field.id ? (
                    <div className="relative z-10 flex items-center gap-1 w-full">
                      <input
                        aria-label={t('profile.fieldNameAria')}
                        autoFocus
                        maxLength={80}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(field.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className={inputClass + ' py-1.5'}
                      />
                      <button
                        onClick={() => saveRename(field.id)}
                        aria-label={t('profile.saveNameAria')}
                        className="p-2 rounded-lg text-cf-primary hover:bg-cf-hero cursor-pointer transition-colors"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setRenamingId(null)}
                        aria-label={t('profile.cancelRenameAria')}
                        className="p-2 rounded-lg text-cf-muted hover:text-cf-text hover:bg-cf-hero cursor-pointer transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="font-semibold text-sm text-cf-text truncate">
                        {field.name}
                      </span>
                      <span className="text-[11px] font-medium bg-cf-hero text-cf-text border border-cf-primary/25 px-2.5 py-0.5 rounded-full shrink-0">
                        {t(`profile.irrigation.${field.irrigation}` as MessageKey)}
                      </span>
                    </>
                  )}
                </div>
                <p className="text-sm text-cf-muted">
                  {t('profile.area')}{' '}
                  <strong className="text-cf-text font-semibold">{field.area_ha != null ? t('profile.areaValue', { value: field.area_ha.toLocaleString(locale) }) : t('profile.notCalculated')}</strong>
                </p>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-cf-muted">
                    {t('profile.created', { date: new Date(field.created_at).toLocaleDateString(locale) })}
                  </p>
                  <div className="relative z-10 flex items-center gap-0.5">
                    <button
                      onClick={() => startRename(field)}
                      aria-label={t('profile.renameAria', { name: field.name })}
                      className="p-2 rounded-lg text-cf-muted hover:text-cf-text hover:bg-cf-hero cursor-pointer transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteField(field)}
                      aria-label={t('profile.deleteAria', { name: field.name })}
                      className="p-2 rounded-lg text-cf-muted hover:text-red-800 hover:bg-red-50 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Crop history */}
      <div className="cf-glass-box p-6 sm:p-7 rounded-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="inline-flex p-2.5 rounded-xl bg-cf-hero text-cf-primary border border-white/70">
            <Calendar className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-semibold text-cf-text">{t('profile.historyTitle')}</h2>
        </div>

        {loading ? (
          <p className="text-sm text-cf-muted">{t('profile.loadingHistory')}</p>
        ) : cropHistory.length === 0 ? (
          <p className="text-sm text-cf-muted leading-relaxed">
            {t('profile.noHistory')}
          </p>
        ) : (
          <div className="space-y-2">
            {cropHistory.map((history) => (
              <div
                key={history.id}
                className="bg-cf-panel border border-cf-border p-3.5 rounded-xl flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Database className="w-4 h-4 text-cf-primary shrink-0" />
                  <span className="truncate text-cf-muted">
                    {history.season_year}: <strong className="text-cf-text font-semibold">{cropLabel(history)}</strong>
                    {history.fields?.name ? (
                      <span className="text-cf-muted"> {t('profile.historyOn', { name: history.fields.name })}</span>
                    ) : null}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="text-xs bg-cf-hero text-cf-text px-2.5 py-0.5 rounded-full border border-cf-primary/20 shrink-0">
                    {sourceLabel(history.source)}
                  </span>
                  <Link
                    to={`/fields/${encodeURIComponent(history.field_id)}?tab=history`}
                    className="p-1.5 rounded-lg text-cf-muted hover:text-cf-text hover:bg-cf-hero transition-colors cursor-pointer"
                    aria-label={t('profile.viewHistory', { field: history.fields?.name ?? '' })}
                    title={t('profile.viewHistory', { field: history.fields?.name ?? '' })}
                  >
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="bg-cf-panel border border-red-700/25 p-6 sm:p-7 rounded-2xl space-y-3">
        <h2 className="text-lg font-semibold text-red-900">{t('profile.deleteTitle')}</h2>
        <p className="text-sm text-cf-muted leading-relaxed max-w-2xl">
          {t('profile.deleteDesc')}
        </p>

        {!showDelete ? (
          <button
            onClick={() => setShowDelete(true)}
            className="cf-btn-glass-danger px-4 py-2.5 rounded-xl text-sm"
          >
            {t('profile.deleteButton')}
          </button>
        ) : (
          <div className="space-y-3 max-w-sm pt-1">
            <label htmlFor="delete-confirm" className="block text-sm text-cf-muted">
              {t('profile.confirmBefore')} <strong className="text-red-900">{t('profile.deleteToken')}</strong> {t('profile.confirmAfter')}
            </label>
            <input
              id="delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              className={inputClass}
            />
            <div className="flex items-center gap-4">
              <button
                onClick={handleDeleteAccount}
                disabled={confirmText.trim().toLocaleUpperCase(locale) !== t('profile.deleteToken') || deleting}
                className="cf-btn-glass-danger px-4 py-2.5 rounded-xl text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? t('profile.deleting') : t('profile.deleteNow')}
              </button>
              <button
                onClick={() => {
                  setShowDelete(false);
                  setConfirmText('');
                }}
                className="text-sm text-cf-muted hover:text-cf-text transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    </div>
  );
};
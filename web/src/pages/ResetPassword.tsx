import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from '../components/LanguageToggle';
import logo from '../assets/CropFatherLogo_green.png';
import { Sprout, KeyRound, AlertCircle } from 'lucide-react';

const inputClass =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 text-sm text-cf-text placeholder:text-cf-muted hover:border-cf-border-strong focus:outline-none focus:border-cf-primary transition-colors';

export const ResetPassword: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { user, isAnonymous, loading: authLoading, updatePassword } = useAuth();
  const { t, translateError } = useLanguage();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (password !== confirm) {
      setErrorMsg(t('reset.mismatch'));
      return;
    }

    setLoading(true);
    const { error } = await updatePassword(password);
    setLoading(false);

    if (error) {
      setErrorMsg(translateError(error));
      return;
    }
    navigate('/dashboard', { replace: true });
  };

  if (authLoading) {
    return (
      <div className="cf-dashboard min-h-screen flex items-center justify-center" role="status" aria-label={t('common.loading')}>
        <Sprout className="w-10 h-10 animate-spin text-cf-primary" />
      </div>
    );
  }

  const hasRecoverySession = Boolean(user) && !isAnonymous;

  return (
    <div className="cf-dashboard min-h-screen flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md mb-5 flex justify-end">
        <LanguageToggle />
      </div>
      <div className="cf-glass-box w-full max-w-md rounded-2xl p-7 sm:p-9">
        <div className="flex items-center gap-3.5 mb-8">
          <div className="cf-glass-pill p-2.5 rounded-lg">
            <img src={logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-cf-text">{t('reset.title')}</h1>
            <p className="text-sm text-cf-muted">{t('reset.subtitle')}</p>
          </div>
        </div>

        {!hasRecoverySession ? (
          <div className="space-y-5">
            <div
              role="alert"
              className="p-3.5 bg-red-50 border border-red-700/30 text-red-900 text-sm rounded-xl flex items-start gap-2.5 leading-relaxed"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-1 text-red-800" />
              <span>{t('reset.invalidLink')}</span>
            </div>
            <Link
              to="/forgot-password"
              className="cf-btn-primary w-full py-3 rounded-xl text-sm flex items-center justify-center"
            >
              {t('reset.requestNew')}
            </Link>
          </div>
        ) : (
          <>
            {errorMsg && (
              <div
                role="alert"
                className="mb-6 p-3.5 bg-red-50 border border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-red-800" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="reset-password" className="block text-sm font-medium text-cf-muted mb-1.5">
                  {t('reset.newPassword')}
                </label>
                <input
                  id="reset-password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="reset-confirm" className="block text-sm font-medium text-cf-muted mb-1.5">
                  {t('reset.confirmPassword')}
                </label>
                <input
                  id="reset-confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="cf-btn-primary w-full py-3 rounded-xl text-sm flex items-center justify-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                <span>{loading ? t('reset.saving') : t('reset.save')}</span>
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
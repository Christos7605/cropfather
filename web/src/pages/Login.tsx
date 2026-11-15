import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from '../components/LanguageToggle';
import logo from '../assets/CropFatherLogo_green.png';
import { LogIn, AlertCircle, ArrowLeft, ShieldCheck } from 'lucide-react';

const inputClass =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 text-sm text-cf-text placeholder:text-cf-muted hover:border-cf-border-strong focus:outline-none focus:border-cf-primary transition-colors';

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { signIn, signInAnonymously, user } = useAuth();
  const { t, translateError } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/dashboard';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);

    const { error } = await signIn(email.trim(), password);
    setLoading(false);

    if (error) {
      setErrorMsg(translateError(error));
      return;
    }
    navigate(from, { replace: true });
  };

  const handleGuest = async () => {
    setErrorMsg(null);
    // A guest who opens /login already has a session and we just continue with it
    if (!user) {
      const { error } = await signInAnonymously();
      if (error) {
        setErrorMsg(t('common.guestUnavailable', { message: translateError(error) }));
        return;
      }
    }
    navigate('/dashboard', { replace: true });
  };

  return (
    <div className="cf-dashboard min-h-screen flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md mb-5 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-cf-muted hover:text-cf-text transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('common.backToHome')}</span>
        </Link>
        <LanguageToggle />
      </div>

      <div className="cf-glass-box w-full max-w-md rounded-2xl p-7 sm:p-9">
        <div className="flex items-center gap-3.5 mb-8">
          <div className="cf-glass-pill p-2.5 rounded-lg">
            <img src={logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-cf-text">{t('common.signIn')}</h1>
            <p className="text-sm text-cf-muted">{t('login.subtitle')}</p>
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mb-6 p-3.5 bg-red-50 border border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 text-red-800" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium text-cf-muted mb-1.5">
              {t('common.emailAddress')}
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="farmer@fieldshift.gr"
              className={inputClass}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="login-password" className="block text-sm font-medium text-cf-muted">
                {t('common.password')}
              </label>
              <Link
                to="/forgot-password"
                className="text-sm text-cf-primary hover:text-cf-text underline underline-offset-2 transition-colors"
              >
                {t('login.forgot')}
              </Link>
            </div>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="cf-btn-primary w-full py-3 rounded-xl text-sm flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" />
            <span>{loading ? t('login.signingIn') : t('common.signIn')}</span>
          </button>
        </form>

        <div className="relative my-7">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-cf-border"></div>
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-cf-panel px-3 text-cf-muted">{t('login.or')}</span>
          </div>
        </div>

        <button
          onClick={handleGuest}
          className="cf-btn-secondary w-full py-3 rounded-xl text-sm flex items-center justify-center gap-2"
        >
          <ShieldCheck className="w-4 h-4 text-cf-primary" />
          <span>{t('login.continueGuest')}</span>
        </button>

        <p className="mt-7 text-center text-sm text-cf-muted">
          {t('login.newHere')}{' '}
          <Link
            to="/register"
            className="text-cf-primary hover:text-cf-text font-medium underline underline-offset-2 transition-colors"
          >
            {t('login.createAccount')}
          </Link>
        </p>
      </div>
    </div>
  );
};
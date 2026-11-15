import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from '../components/LanguageToggle';
import logo from '../assets/CropFatherLogo_green.png';
import { UserPlus, AlertCircle, ArrowLeft, Info } from 'lucide-react';

const inputClass =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 text-sm text-cf-text placeholder:text-cf-muted hover:border-cf-border-strong focus:outline-none focus:border-cf-primary transition-colors';

export const Register: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { signUp, isAnonymous } = useAuth();
  const { t, translateError } = useLanguage();
  const navigate = useNavigate();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfo(null);
    setLoading(true);

    const { error, needsEmailConfirmation } = await signUp(email.trim(), password, displayName.trim());
    setLoading(false);

    if (error) {
      setErrorMsg(translateError(error));
      return;
    }
    if (needsEmailConfirmation) {
      setInfo(t('register.checkEmail'));
      return;
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
            <h1 className="text-xl font-semibold tracking-tight text-cf-text">{t('register.title')}</h1>
            <p className="text-sm text-cf-muted">{t('register.subtitle')}</p>
          </div>
        </div>

        {isAnonymous && (
          <div className="mb-6 p-3.5 cf-glass-sage text-cf-text text-sm rounded-xl flex items-start gap-2.5 leading-relaxed">
            <Info className="w-4 h-4 shrink-0 mt-1 text-cf-primary" />
            <span>{t('register.guestInfo')}</span>
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="mb-6 p-3.5 bg-red-50 border border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 text-red-800" />
            <span>{errorMsg}</span>
          </div>
        )}

        {info && (
          <div
            role="status"
            className="mb-6 p-3.5 cf-glass-sage text-cf-text text-sm rounded-xl leading-relaxed"
          >
            {info}
          </div>
        )}

        <form onSubmit={handleRegister} className="space-y-5">
          <div>
            <label htmlFor="register-name" className="block text-sm font-medium text-cf-muted mb-1.5">
              {t('common.yourName')}
            </label>
            <input
              id="register-name"
              type="text"
              required
              maxLength={80}
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('register.namePlaceholder')}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="register-email" className="block text-sm font-medium text-cf-muted mb-1.5">
              {t('common.emailAddress')}
            </label>
            <input
              id="register-email"
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
            <label htmlFor="register-password" className="block text-sm font-medium text-cf-muted mb-1.5">
              {t('register.passwordLabel')}
            </label>
            <input
              id="register-password"
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

          <button
            type="submit"
            disabled={loading}
            className="cf-btn-primary w-full py-3 rounded-xl text-sm flex items-center justify-center gap-2"
          >
            <UserPlus className="w-4 h-4" />
            <span>{loading ? t('register.creating') : t('common.createAccount')}</span>
          </button>
        </form>

        <p className="mt-7 text-center text-sm text-cf-muted">
          {t('register.alreadyRegistered')}{' '}
          <Link
            to="/login"
            className="text-cf-primary hover:text-cf-text font-medium underline underline-offset-2 transition-colors"
          >
            {t('common.signIn')}
          </Link>
        </p>
      </div>
    </div>
  );
};
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from '../components/LanguageToggle';
import logo from '../assets/CropFatherLogo_green.png';
import { Mail, AlertCircle, ArrowLeft } from 'lucide-react';

const inputClass =
  'w-full bg-cf-panel border border-cf-border rounded-xl px-3.5 py-3 text-sm text-cf-text placeholder:text-cf-muted hover:border-cf-border-strong focus:outline-none focus:border-cf-primary transition-colors';

export const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { resetPassword } = useAuth();
  const { t, translateError } = useLanguage();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);

    const { error } = await resetPassword(email.trim());
    setLoading(false);

    if (error) {
      setErrorMsg(translateError(error));
      return;
    }
    setSent(true);
  };

  return (
    <div className="cf-dashboard min-h-screen flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md mb-5 flex items-center justify-between">
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-sm text-cf-muted hover:text-cf-text transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('forgot.backToSignIn')}</span>
        </Link>
        <LanguageToggle />
      </div>

      <div className="cf-glass-box w-full max-w-md rounded-2xl p-7 sm:p-9">
        <div className="flex items-center gap-3.5 mb-8">
          <div className="cf-glass-pill p-2.5 rounded-lg">
            <img src={logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-cf-text">{t('forgot.title')}</h1>
            <p className="text-sm text-cf-muted">{t('forgot.subtitle')}</p>
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

        {sent ? (
          <div
            role="status"
            className="p-3.5 cf-glass-sage text-cf-text text-sm rounded-xl leading-relaxed"
          >
            {t('forgot.sent')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="forgot-email" className="block text-sm font-medium text-cf-muted mb-1.5">
                {t('common.emailAddress')}
              </label>
              <input
                id="forgot-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="farmer@fieldshift.gr"
                className={inputClass}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="cf-btn-primary w-full py-3 rounded-xl text-sm flex items-center justify-center gap-2"
            >
              <Mail className="w-4 h-4" />
              <span>{loading ? t('forgot.sending') : t('forgot.send')}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
import React from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, User as UserIcon, Map as MapIcon, LayoutDashboard } from 'lucide-react';
import { confirmLeave } from '../lib/navigationGuard';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from './LanguageToggle';
import { BrandMark, SITE_HEADER_CLASS } from './BrandMark';
import { supabase } from '../lib/supabase';

const SECTION_KEYS = {
  '/dashboard': 'nav.dashboard',
  '/map': 'nav.map',
  '/profile': 'nav.profile',
  '/farm-profile': 'nav.farmProfile',
} as const;

export const AppLayout: React.FC = () => {
  const { profile, isAnonymous, signOut } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();

  const displayName = isAnonymous ? t('common.guest') : profile?.display_name ?? t('common.farmer');
  const path = location.pathname;
  const sectionKey = path.endsWith('/questionnaire')
    ? 'nav.questionnaire'
    : path.startsWith('/prediction')
      ? 'nav.prediction'
      : path.startsWith('/fields/')
        ? 'nav.field'
        : SECTION_KEYS[path as keyof typeof SECTION_KEYS];
  const sectionLabel = sectionKey ? t(sectionKey) : 'Field Shift';

  const onMap = location.pathname === '/map';
  const onProfile = location.pathname === '/profile';
  const switchTo = onMap
    ? { path: '/dashboard', label: t('nav.dashboard'), Icon: LayoutDashboard }
    : { path: '/map', label: t('nav.map'), Icon: MapIcon };
  const places = onProfile
    ? [
        { path: '/map', label: t('nav.map'), Icon: MapIcon },
        { path: '/dashboard', label: t('nav.dashboard'), Icon: LayoutDashboard },
      ]
    : [switchTo];

  const handleSignOut = async () => {
    if (!confirmLeave()) return;
    if (isAnonymous && !window.confirm(t('layout.leaveGuestConfirm'))) return;

    if (isAnonymous) {
      // A guest can never return to this session, so remove the guest and everything they created
      const { error } = await supabase.rpc('delete_my_account');
      if (error) console.warn('Guest cleanup failed, the nightly cleanup will remove it:', error.message);
    }
    await signOut();
    navigate(isAnonymous ? '/' : '/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className={SITE_HEADER_CLASS}>
        <div className="w-full flex items-center justify-between">
          <Link
            to="/"
            className="flex items-center gap-3 group cursor-pointer"
            onClick={(e) => {
              if (!confirmLeave()) e.preventDefault();
            }}
          >
            <BrandMark />
            <span className="leading-tight">
              <span className="cf-brand-title text-xl sm:text-2xl text-cf-text tracking-tight block">
                Cropfather
              </span>
              <span className="text-xs text-cf-muted font-medium">{sectionLabel}</span>
            </span>
          </Link>

          <div className="flex items-center gap-2.5 sm:gap-3.5">
            {places.map(({ path: to, label, Icon }) => (
              <button
                key={to}
                onClick={() => confirmLeave() && navigate(to)}
                className="cf-btn-secondary px-3.5 py-2 rounded-xl text-sm flex items-center gap-2 cursor-pointer"
                aria-label={label}
              >
                <Icon className="w-4 h-4 text-cf-primary" />
                <span className="text-cf-text font-medium hidden sm:inline">{label}</span>
              </button>
            ))}

            {!onProfile && (
              <button
                onClick={() => confirmLeave() && navigate('/profile')}
                className="cf-btn-secondary px-3.5 py-2 rounded-xl text-sm flex items-center gap-2 cursor-pointer"
              >
                <UserIcon className="w-4 h-4 text-cf-primary" />
                <span className="text-cf-text font-medium max-w-[140px] truncate">{displayName}</span>
              </button>
            )}

            <LanguageToggle />

            <button
              onClick={handleSignOut}
              className="cf-glass-pill hover:border-red-400/50 text-red-700 p-2 rounded-xl transition-colors cursor-pointer"
              title={isAnonymous ? t('layout.exitGuest') : t('layout.signOut')}
              aria-label={isAnonymous ? t('layout.exitGuest') : t('layout.signOut')}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
};
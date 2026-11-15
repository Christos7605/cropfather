import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Sprout } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const Spinner: React.FC = () => {
  const { t } = useLanguage();
  return (
    <div
      className="min-h-screen bg-ground flex items-center justify-center"
      role="status"
      aria-label={t('common.loading')}
    >
      <Sprout className="w-10 h-10 animate-spin text-sage" />
    </div>
  );
};

export const ProtectedRoute: React.FC = () => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner />;
  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
};

// Keeps signed-in (non-guest) users away from /login and /register
// Guests may still open them, so they can upgrade to a real account
export const PublicOnlyRoute: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) return <Spinner />;
  return user && !user.is_anonymous ? <Navigate to="/dashboard" replace /> : <Outlet />;
};
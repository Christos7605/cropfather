import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { ProtectedRoute, PublicOnlyRoute } from './components/ProtectedRoute';
import { AppLayout } from './components/AppLayout';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { Profile } from './pages/Profile';
import { lazy, Suspense } from 'react';
import { Analytics } from '@vercel/analytics/react';

const FieldMap = lazy(() => import('./pages/FieldMap').then((m) => ({ default: m.FieldMap })));
const FieldPage = lazy(() => import('./pages/FieldPage').then((m) => ({ default: m.FieldPage })));
const FieldHistoryRedirect = lazy(() => import('./pages/FieldPage').then((m) => ({ default: m.FieldHistoryRedirect })));
const FieldQuestionnaire = lazy(() => import('./pages/FieldQuestionnaire').then((m) => ({ default: m.FieldQuestionnaire })));
const FarmProfile = lazy(() => import('./pages/FarmProfile').then((m) => ({ default: m.FarmProfile })));
const Prediction = lazy(() => import('./pages/Prediction').then((m) => ({ default: m.Prediction })));
const PredictionField = lazy(() => import('./pages/PredictionField').then((m) => ({ default: m.PredictionField })));

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <BrowserRouter>
          <Routes>
            {/* Public landing page */}
            <Route path="/" element={<Home />} />

            {/* Auth pages: hidden from signed-in (non-guest) users */}
            <Route element={<PublicOnlyRoute />}>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
            </Route>

            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Signed-in application routes share one header */}
            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route
                  path="/map"
                  element={
                    <Suspense fallback={null}>
                      <FieldMap />
                    </Suspense>
                  }
                />
                {/* One field: Overview, Crop history and Questionnaire tabs (?tab=history|questionnaire) */}
                <Route
                  path="/fields/:fieldId"
                  element={
                    <Suspense fallback={null}>
                      <FieldPage />
                    </Suspense>
                  }
                />
                {/* Old address of the crop history page: opens the Crop history tab */}
                <Route
                  path="/fields/:fieldId/history"
                  element={
                    <Suspense fallback={null}>
                      <FieldHistoryRedirect />
                    </Suspense>
                  }
                />
                <Route
                  path="/fields/:fieldId/questionnaire"
                  element={
                    <Suspense fallback={null}>
                      <FieldQuestionnaire />
                    </Suspense>
                  }
                />
                <Route
                  path="/farm-profile"
                  element={
                    <Suspense fallback={null}>
                      <FarmProfile />
                    </Suspense>
                  }
                />
                <Route path="/profile" element={<Profile />} />
                <Route
                  path="/prediction"
                  element={
                    <Suspense fallback={null}>
                      <Prediction />
                    </Suspense>
                  }
                />
                <Route
                  path="/prediction/fields/:fieldId"
                  element={
                    <Suspense fallback={null}>
                      <PredictionField />
                    </Suspense>
                  }
                />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Analytics />
        </BrowserRouter>
      </LanguageProvider>
    </AuthProvider>
  );
}
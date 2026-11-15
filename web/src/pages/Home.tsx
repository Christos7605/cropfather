import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageToggle } from '../components/LanguageToggle';
import { BrandMark, SITE_HEADER_CLASS } from '../components/BrandMark';
import { HeaderMenu, headerMenuItem } from '../components/HeaderMenu';
import slide1 from '../assets/carousel/Carousel_image1.jpg';
import slide2 from '../assets/carousel/Carousel_image2.jpg';
import slide3 from '../assets/carousel/Carousel_image3.jpg';
import logo from '../assets/CropFatherLogo_green.png';
import {
  Sprout,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Shield,
  Database,
  Compass,
  BarChart3,
  AlertCircle,
  Phone,
  Mail,
  Smartphone,
} from 'lucide-react';
import { InstagramIcon } from '../components/InstagramIcon';

const HERO_SLIDES = [slide1, slide2, slide3];

const HeroCarousel: React.FC = () => {
  const { t } = useLanguage();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % HERO_SLIDES.length);
    }, 6000);
    return () => window.clearInterval(id);
  }, [index]);

  const go = (step: number) => {
    setIndex((current) => (current + step + HERO_SLIDES.length) % HERO_SLIDES.length);
  };

  return (
    <div className="relative h-64 sm:h-80 lg:absolute lg:inset-y-0 lg:right-0 lg:h-auto lg:w-[56%]">
      <div className="absolute inset-0 lg:[clip-path:polygon(14%_0,100%_0,100%_100%,0_100%)]">
        {HERO_SLIDES.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
              i === index ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => go(-1)}
        aria-label={t('home.carouselPrev')}
        className="cf-glass-orb absolute left-3 top-1/2 z-10 -translate-y-1/2 lg:left-[18%] w-10 h-10 rounded-full flex items-center justify-center cursor-pointer"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={() => go(1)}
        aria-label={t('home.carouselNext')}
        className="cf-glass-orb absolute right-3 top-1/2 z-10 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center cursor-pointer"
      >
        <ChevronRight className="w-5 h-5" />
      </button>
      <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 flex items-center gap-2">
        {HERO_SLIDES.map((src, i) => (
          <button
            key={src}
            type="button"
            aria-label={t('home.carouselGo', { n: String(i + 1) })}
            aria-current={i === index ? 'true' : undefined}
            onClick={() => setIndex(i)}
            className={`h-2 rounded-full cursor-pointer transition-all ${
              i === index ? 'w-5 bg-cf-primary' : 'w-2 bg-cf-panel/85'
            }`}
          />
        ))}
      </div>
    </div>
  );
};

export const Home: React.FC = () => {
  const navigate = useNavigate();
  const { user, loading, signInAnonymously } = useAuth();
  const { t, translateError } = useLanguage();
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestLoading, setGuestLoading] = useState(false);

  const handleGuestEntry = async () => {
    setGuestError(null);
    if (!user) {
      setGuestLoading(true);
      const { error } = await signInAnonymously();
      setGuestLoading(false);
      if (error) {
        setGuestError(t('common.guestUnavailable', { message: translateError(error) }));
        return;
      }
    }
    navigate('/dashboard');
  };

  const layers = [
    { label: t('home.climate'), swatch: 'bg-water', sources: 'Giovanni IMERG, ISS ECOSTRESS AppEEARS, MODIS v2-v3, LANDSAT-8/9, MERRA-2' },
    { label: t('home.soil'), swatch: 'bg-clay', sources: 'SoilGrids 2.0, Copernicus DEM, Google Earth Engine' },
    { label: t('home.water'), swatch: 'bg-sage', sources: 'YPEN' },
  ];

  return (
    <div className="cf-home min-h-screen flex flex-col justify-between selection:bg-cf-hero selection:text-cf-text">
      <header className={SITE_HEADER_CLASS}>
        <div className="w-full flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group cursor-pointer min-w-0">
            <BrandMark />
            <span className="cf-brand-title text-xl sm:text-2xl text-cf-text tracking-tight">
              Cropfather
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-2.5 sm:gap-3.5 text-sm font-medium">
            <LanguageToggle />
            {loading ? null : user ? (
              <button
                onClick={() => navigate('/dashboard')}
                className="cf-btn-primary px-4 py-2 rounded-xl flex items-center gap-2"
              >
                <span>{t('home.openDashboard')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <>
                <Link
                  to="/login"
                  className="cf-btn-secondary px-3.5 py-2 rounded-xl transition-colors font-medium"
                >
                  {t('common.signIn')}
                </Link>
                <Link to="/register" className="cf-btn-primary px-4 py-2 rounded-xl">
                  {t('common.createAccount')}
                </Link>
              </>
            )}
          </div>

          <HeaderMenu labelOpen={t('common.openMenu')} labelClose={t('common.closeMenu')} closeKey={user ? 'in' : 'out'}>
            <div className="flex items-center justify-between gap-3 px-1">
              <span className="text-sm text-cf-muted">{t('common.language')}</span>
              <LanguageToggle />
            </div>
            {loading ? null : user ? (
              <button onClick={() => navigate('/dashboard')} className="cf-btn-primary w-full px-4 py-2.5 rounded-xl flex items-center justify-center gap-2">
                <span>{t('home.openDashboard')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <>
                <Link to="/login" className={headerMenuItem}>
                  {t('common.signIn')}
                </Link>
                <Link to="/register" className="cf-btn-primary w-full px-4 py-2.5 rounded-xl text-center">
                  {t('common.createAccount')}
                </Link>
              </>
            )}
          </HeaderMenu>
        </div>
      </header>

      {/* 16:9 Widescreen-optimized main layout */}
      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-8 xl:px-12 py-6 lg:py-8 flex flex-col justify-center gap-6 lg:gap-8">
        {/* Soft Sage Frosted Hero Container */}
        <section className="relative rounded-3xl bg-cf-hero/85 border border-white/80 shadow-[0_20px_50px_-18px_rgba(27,41,33,0.1)] overflow-hidden">
          <div className="relative z-10 lg:w-[48%] p-6 sm:p-10 lg:p-12 space-y-6">
              <div className="cf-glass-pill inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs sm:text-sm">
                <Compass className="w-4 h-4 text-cf-primary shrink-0" />
                <span>{t('home.pilot')}</span>
              </div>

              <h1 className="text-3xl sm:text-4xl lg:text-[2.85rem] xl:text-[3.2rem] font-semibold tracking-tight text-cf-text leading-[1.1] text-balance">
                {t('home.title')}
              </h1>

              <p className="text-sm sm:text-base lg:text-[1.05rem] text-cf-muted leading-relaxed max-w-2xl">
                {t('home.subtitle')}
              </p>

              {/* Primary Functional CTA Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  onClick={() => navigate(user ? '/dashboard' : '/register')}
                  className="cf-btn-primary px-6 py-3 rounded-xl text-sm flex items-center gap-2"
                >
                  <Sprout className="w-4 h-4" />
                  <span>{user ? t('home.openDashboard') : t('home.ctaCreate')}</span>
                </button>

                {!user && !loading && (
                  <button
                    onClick={handleGuestEntry}
                    disabled={guestLoading}
                    className="guest-btn cf-btn-secondary text-sm px-6 py-3 rounded-xl"
                  >
                    {guestLoading ? t('home.startingGuest') : t('home.tryGuest')}
                  </button>
                )}
              </div>

              {!user && !loading && (
                <p className="text-xs sm:text-sm text-cf-muted max-w-xl">
                  {t('home.guestNote')}
                </p>
              )}

              {guestError && (
                <div
                  role="alert"
                  className="cf-glass-box max-w-xl p-3.5 border-red-700/30 text-red-900 text-sm rounded-xl flex items-center gap-2.5"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-700" />
                  <span>{guestError}</span>
                </div>
              )}
          </div>
          <HeroCarousel />
        </section>

        {/* 16:9 Widescreen Lower Dock: 3 Frosted Glass Feature Boxes + Frosted Glass Data Sources Box */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5 items-stretch">
          <div className="cf-glass-box md:col-span-2 lg:col-span-8 rounded-2xl p-6 sm:p-7 flex flex-col justify-between">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-0 lg:divide-x divide-cf-border h-full">
              <div className="lg:pr-6 flex flex-col justify-between space-y-3">
                <div className="space-y-3">
                  <div className="inline-flex p-2.5 rounded-xl bg-cf-hero/80 text-cf-primary border border-white/60">
                    <Shield className="w-5 h-5" />
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold text-cf-text">{t('home.privacyTitle')}</h3>
                  <p className="text-sm text-cf-muted leading-relaxed">
                    {t('home.privacyDesc')}
                  </p>
                </div>
              </div>

              <div className="lg:px-6 pt-5 lg:pt-0 border-t lg:border-t-0 border-cf-border flex flex-col justify-between space-y-3">
                <div className="space-y-3">
                  <div className="inline-flex p-2.5 rounded-xl bg-cf-hero/80 text-cf-primary border border-white/60">
                    <BarChart3 className="w-5 h-5" />
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold text-cf-text">{t('home.scoringTitle')}</h3>
                  <p className="text-sm text-cf-muted leading-relaxed">
                    {t('home.scoringDesc')}
                  </p>
                </div>
              </div>

              <div className="lg:pl-6 pt-5 lg:pt-0 border-t lg:border-t-0 border-cf-border flex flex-col justify-between space-y-3">
                <div className="space-y-3">
                  <div className="inline-flex p-2.5 rounded-xl bg-cf-hero/80 text-cf-primary border border-white/60">
                    <Database className="w-5 h-5" />
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold text-cf-text">{t('home.waterTitle')}</h3>
                  <p className="text-sm text-cf-muted leading-relaxed">
                    {t('home.waterDesc')}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Frosted Liquid Glass Data Sources Box */}
          <div className="cf-glass-box md:col-span-2 lg:col-span-4 rounded-2xl p-6 sm:p-7 flex flex-col justify-between">
            <div>
              <h2 className="text-base font-semibold text-cf-text pb-3 border-b border-cf-border">
                {t('home.dataSources')}
              </h2>

              <dl className="divide-y divide-cf-border">
                {layers.map((layer) => (
                  <div key={layer.label} className="flex items-baseline justify-between gap-3 py-2.5">
                    <dt className="flex items-center gap-2 text-xs sm:text-sm font-medium text-cf-muted shrink-0">
                      <span
                        aria-hidden="true"
                        className={`w-2.5 h-2.5 rounded-sm shrink-0 ${layer.swatch}`}
                      />
                      {layer.label}
                    </dt>
                    <dd className="text-xs sm:text-sm text-cf-text text-right font-medium">{layer.sources}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <p className="pt-3 mt-1 border-t border-cf-border text-xs text-cf-muted leading-relaxed">
              {t('home.integrationNote')}
            </p>
          </div>
        </section>
      </main>

      {/* Comprehensive Paperwork & Contact Footer (Non-functional showcase items) */}
      <footer className="cf-glass border-t mt-8 px-4 sm:px-8 xl:px-12 pt-10 pb-6 text-xs text-cf-muted">
        <div className="max-w-[1440px] mx-auto space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-8 pb-8 border-b border-cf-border">
            {/* Brand & Mission */}
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

            {/* Contact Info */}
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

            {/* Platform & Resources (Non-functional) */}
            <div className="lg:col-span-2 space-y-2.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-cf-text">{t('footer.platformTitle')}</h4>
              <ul className="space-y-1.5">
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.faq')}</span></li>
                <li>
                  <a href="/presentation.pptx" download="Cropfather-presentation.pptx" className="hover:text-cf-text transition-colors">
                    {t('footer.presentation')}
                  </a>
                </li>
                <li>
                  <a href="https://www.ktimatologio.gr/" className="hover:text-cf-text transition-colors">
                    {t('footer.cadastre')}
                  </a>
                </li>
                <li><span className="hover:text-cf-text transition-colors cursor-default">{t('footer.apiDocs')}</span></li>
              </ul>
            </div>

            {/* Legal & Paperwork (Non-functional) */}
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




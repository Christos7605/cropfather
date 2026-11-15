import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import type { Language } from '../i18n/language';

const OPTIONS: { code: Language; label: string; name: string }[] = [
  { code: 'el', label: 'EL', name: 'Ελληνικά' },
  { code: 'en', label: 'EN', name: 'English' },
];

export const LanguageToggle: React.FC = () => {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className="inline-flex rounded-lg border border-line bg-ground-deep p-0.5 text-xs font-medium"
    >
      {OPTIONS.map(({ code, label, name }) => {
        const active = language === code;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            title={name}
            aria-pressed={active}
            onClick={() => setLanguage(code)}
            className={
              active
                ? 'px-2.5 py-1 rounded-md bg-raised text-ink font-semibold shadow-sm cursor-default'
                : 'px-2.5 py-1 rounded-md text-ink-faint hover:text-ink transition-colors cursor-pointer'
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};
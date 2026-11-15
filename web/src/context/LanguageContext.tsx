import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { en } from '../i18n/en';
import type { MessageKey, Messages } from '../i18n/en';
import { el } from '../i18n/el';
import { detectLanguage, isLanguage, storeLanguage } from '../i18n/language';
import type { Language } from '../i18n/language';

type Vars = Record<string, string | number>;
type ErrorLike = { message: string; code?: string } | null | undefined;

interface LanguageContextType {
  language: Language;
  // BCP 47 locale for dates and numbers, e.g. 'el-GR'
  locale: string;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  // Localised text for an auth/database error, falling back to the server's message
  translateError: (error: ErrorLike) => string;
}

const dictionaries: Record<Language, Messages> = { en, el };
const LOCALES: Record<Language, string> = { en: 'en-GB', el: 'el-GR' };

function lookup(dictionary: Messages, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile, updateProfile } = useAuth();
  const [language, setLanguageState] = useState<Language>(() => detectLanguage());

  const userId = user?.id ?? null;
  const savedLanguage = profile?.language ?? null;

  // Signed-in users: the language is the one saved on their profile
  useEffect(() => {
    if (savedLanguage && isLanguage(savedLanguage)) {
      setLanguageState(savedLanguage);
      storeLanguage(savedLanguage);
    }
  }, [savedLanguage]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = lookup(dictionaries[language], 'meta.title') ?? 'Field Shift';
  }, [language]);

  const setLanguage = useCallback(
    (next: Language) => {
      setLanguageState(next);
      storeLanguage(next);
      if (userId) {
        void updateProfile({ language: next }).then(({ error }) => {
          if (error) console.error('Could not save language:', error.message);
        });
      }
    },
    [userId, updateProfile]
  );

  const t = useCallback(
    (key: MessageKey, vars?: Vars) =>
      interpolate(lookup(dictionaries[language], key) ?? lookup(en, key) ?? key, vars),
    [language]
  );

  const translateError = useCallback(
    (error: ErrorLike) => {
      if (!error) return '';
      if (error.code) {
        const key = `errors.${error.code}`;
        const hit = lookup(dictionaries[language], key) ?? lookup(en, key);
        if (hit) return hit;
      }
      return error.message;
    },
    [language]
  );

  const value = useMemo<LanguageContextType>(
    () => ({ language, locale: LOCALES[language], setLanguage, t, translateError }),
    [language, setLanguage, t, translateError]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider');
  return context;
};
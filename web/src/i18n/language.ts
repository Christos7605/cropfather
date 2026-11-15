export type Language = 'el' | 'en';

export const LANGUAGE_STORAGE_KEY = 'fieldshift.language';

export const isLanguage = (value: unknown): value is Language => value === 'el' || value === 'en';

export function getStoredLanguage(): Language | null {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null; // storage can be blocked (private mode, strict settings)
  }
}

export function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // ignore, since the choice still applies for this page load
  }
}

// Saved choice first, then the browser language (Greek browsers get Greek), else English
export function detectLanguage(): Language {
  const stored = getStoredLanguage();
  if (stored) return stored;
  const browser = typeof navigator !== 'undefined' ? navigator.language : '';
  return browser.toLowerCase().startsWith('el') ? 'el' : 'en';
}
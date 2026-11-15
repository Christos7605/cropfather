import React from 'react';
import { useLanguage } from '../../context/LanguageContext';
import type { MessageKey } from '../../i18n/en';

// "Who did the work?" for one fertiliser or plant protection card: the farmer (or family) or a
// contractor / hired worker, and then optionally what the work cost per stremma

const inputCls =
  'w-full bg-cf-panel border border-cf-border rounded-lg px-3.5 py-2.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none focus:border-cf-primary transition-colors aria-[invalid=true]:border-red-400/60';

interface Props {
  // Prefix for element ids, unique per card
  idPrefix: string;
  contractor: boolean;
  fee: string; // € per stremma
  error?: MessageKey;
  onChange: (patch: { contractor: boolean; fee: string }) => void;
}

export const WorkBySection: React.FC<Props> = ({ idPrefix, contractor, fee, error, onChange }) => {
  const { t } = useLanguage();
  const id = (f: string) => `${idPrefix}-${f}`;
  return (
    <div className="space-y-1.5">
      <p id={id('who')} className="text-sm font-medium text-cf-muted">
        {t('seasons.prot.who')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 items-start">
        <div role="radiogroup" aria-labelledby={id('who')} className="contents">
          {([false, true] as const).map((hired) => {
            const on = contractor === hired;
            return (
              <button
                key={String(hired)}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ contractor: hired, fee: hired ? fee : '' })}
                className={`text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                  on ? 'border-cf-primary/60 bg-cf-hero/15' : 'border-cf-border bg-cf-panel hover:border-cf-border-strong'
                }`}
              >
                <span className={`block text-sm font-medium ${on ? 'text-cf-text' : 'text-cf-muted'}`}>
                  {t(hired ? 'seasons.prot.whoContractor' : 'seasons.prot.whoSelf')}
                </span>
                <span className="block text-xs text-cf-muted">
                  {t(hired ? 'seasons.prot.whoContractorDesc' : 'seasons.prot.whoSelfDesc')}
                </span>
              </button>
            );
          })}
        </div>
        {contractor && (
          <div className="space-y-1.5">
            <label htmlFor={id('fee')} className="sr-only">
              {t('seasons.prot.fee')}
            </label>
            <input
              id={id('fee')}
              inputMode="decimal"
              value={fee}
              onChange={(e) => onChange({ contractor, fee: e.target.value })}
              placeholder={t('seasons.prot.fee')}
              aria-invalid={error ? true : undefined}
              className={`${inputCls} tabular-nums`}
            />
            {error ? (
              <p className="text-xs text-red-800">{t(error)}</p>
            ) : (
              <p className="text-xs text-cf-muted">{t('seasons.prot.feeHint')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
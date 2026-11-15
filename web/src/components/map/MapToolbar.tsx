import React, { useRef, useState } from 'react';
import { Search, Loader2, Satellite, Map as MapIcon, X, LandPlot, Droplets } from 'lucide-react';
import { WELL_COLORS } from '../../lib/mapConfig';
import type { LngLatBoundsLike } from 'maplibre-gl';
import { useLanguage } from '../../context/LanguageContext';
import { REGION_ORDER, REGIONS, type RegionId } from '../../lib/mapConfig';
import type { Basemap, ParcelStatus } from './FieldMapCanvas';

// Place search uses OpenStreetMap Nominatim. Its usage policy allows at most one request
// per second, no search-as-you-type, and asks clients to cache results, so we only search
// on submit and cache answers for the session

// Greece first, and we can widen (e.g. 'gr,cy') or remove to go global
const SEARCH_COUNTRIES = 'gr';

interface PlaceResult {
  name: string;
  bounds: LngLatBoundsLike;
}

const searchCache = new Map<string, PlaceResult[]>();
let lastSearchAt = 0;

async function searchPlaces(query: string, language: string): Promise<PlaceResult[]> {
  const key = `${language}|${query.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const wait = 1100 - (Date.now() - lastSearchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '6',
    'accept-language': language,
  });
  if (SEARCH_COUNTRIES) params.set('countrycodes', SEARCH_COUNTRIES);

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const rows = (await res.json()) as { display_name: string; boundingbox: [string, string, string, string] }[];
  const results = rows.map((r) => {
    const [south, north, west, east] = r.boundingbox.map(Number);
    return { name: r.display_name, bounds: [west, south, east, north] as LngLatBoundsLike };
  });
  searchCache.set(key, results);
  return results;
}

interface Props {
  basemap: Basemap;
  onBasemapChange: (b: Basemap) => void;
  onGoTo: (bounds: LngLatBoundsLike, maxZoom?: number) => void;
  showParcels: boolean;
  onToggleParcels: () => void;
  parcelStatus: ParcelStatus;
  showWells: boolean;
  onToggleWells: () => void;
  wellStatus: ParcelStatus;
  // While choosing a field's water source the points must stay visible
  wellsLocked: boolean;
  // Finds a Cadastre parcel by ΚΑΕΚ and moves the map to it
  onKaekSearch: (kaek: string) => Promise<KaekSearchResult>;
}

export type KaekSearchResult = 'found' | 'notFound' | 'invalid' | 'error';

export const MapToolbar: React.FC<Props> = ({
  basemap,
  onBasemapChange,
  onGoTo,
  showParcels,
  onToggleParcels,
  parcelStatus,
  onKaekSearch,
  showWells,
  onToggleWells,
  wellStatus,
  wellsLocked,
}) => {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search by ΚΑΕΚ (only while the Cadastre layer is on)
  const [kaek, setKaek] = useState('');
  const [kaekBusy, setKaekBusy] = useState(false);
  const [kaekMessage, setKaekMessage] = useState<string | null>(null);

  const submitKaek = async (e: React.FormEvent) => {
    e.preventDefault();
    if (kaekBusy || !kaek.trim()) return;
    setKaekBusy(true);
    setKaekMessage(null);
    try {
      const result = await onKaekSearch(kaek);
      if (result === 'invalid') setKaekMessage(t('map.cadastre.kaekInvalid'));
      else if (result === 'notFound') setKaekMessage(t('map.cadastre.kaekNotFound'));
      else if (result === 'error') setKaekMessage(t('map.cadastre.loadFailed'));
    } finally {
      setKaekBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2 || searching) return;
    setSearching(true);
    setError(null);
    try {
      const found = await searchPlaces(q, language);
      setResults(found);
      if (found.length === 0) setError(t('map.searchNoResults'));
    } catch {
      setResults(null);
      setError(t('map.searchFailed'));
    } finally {
      setSearching(false);
    }
  };

  const pick = (r: PlaceResult) => {
    onGoTo(r.bounds, 15);
    setResults(null);
    setError(null);
  };

  const clear = () => {
    setQuery('');
    setResults(null);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <>
      {/* Search + region shortcuts */}
      <div className="absolute top-3 left-3 right-16 sm:right-auto sm:w-[22rem] z-10 space-y-2">
        <form onSubmit={submit} className="fs-map-panel rounded-xl flex items-center gap-1 p-1.5" role="search">
          <Search className="w-4 h-4 text-cf-muted ml-2 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('map.searchPlaceholder')}
            aria-label={t('map.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent px-2 py-1.5 text-sm text-cf-text placeholder:text-cf-muted focus:outline-none"
          />
          {query && !searching && (
            <button
              type="button"
              onClick={clear}
              className="p-1.5 rounded-md text-cf-muted hover:text-cf-text hover:bg-cf-hero transition-colors cursor-pointer"
              aria-label={t('common.cancel')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={searching || query.trim().length < 2}
            className="cf-btn-primary px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5"
          >
            {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span className="hidden sm:inline">{searching ? t('map.searching') : t('map.searchButton')}</span>
          </button>
        </form>

        {showParcels && (
          <>
            <form
              onSubmit={submitKaek}
              className="fs-map-panel rounded-xl flex items-center gap-1 p-1.5"
              role="search"
              aria-label={t('map.cadastre.kaekSearchLabel')}
            >
              <LandPlot className="w-4 h-4 text-cf-primary ml-2 shrink-0" aria-hidden="true" />
              <input
                type="search"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={kaek}
                maxLength={30}
                onChange={(e) => {
                  setKaek(e.target.value);
                  setKaekMessage(null);
                }}
                placeholder={t('map.cadastre.kaekPlaceholder')}
                aria-label={t('map.cadastre.kaekSearchLabel')}
                className="flex-1 min-w-0 bg-transparent px-2 py-1.5 text-sm text-cf-text tabular-nums placeholder:text-cf-muted focus:outline-none"
              />
              <button
                type="submit"
                disabled={kaekBusy || !kaek.trim()}
                className="cf-btn-primary px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5"
              >
                {kaekBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                <span className="hidden sm:inline">{kaekBusy ? t('map.searching') : t('map.cadastre.kaekButton')}</span>
              </button>
            </form>
            {kaekMessage && (
              <p className="fs-map-panel rounded-xl px-4 py-2.5 text-sm text-cf-muted" aria-live="polite">
                {kaekMessage}
              </p>
            )}
          </>
        )}

        {(results && results.length > 0) || error ? (
          <div className="fs-map-panel rounded-xl overflow-hidden" aria-live="polite">
            {error && <p className="px-4 py-3 text-sm text-cf-muted">{error}</p>}
            {results && results.length > 0 && (
              <ul className="max-h-64 overflow-y-auto divide-y divide-cf-border/60">
                {results.map((r, i) => (
                  <li key={`${r.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      className="w-full text-left px-4 py-2.5 text-sm text-cf-muted hover:bg-cf-hero hover:text-cf-text transition-colors cursor-pointer"
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {/* One sideways-scrolling row on phones, wrapped rows on larger screens */}
        <div
          className="fs-chip-row flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto sm:overflow-visible -mx-1 px-1 pb-0.5"
          role="group"
          aria-label={t('map.regionsLabel')}
        >
          {REGION_ORDER.map((id: RegionId) => (
            <button
              key={id}
              type="button"
              onClick={() => onGoTo(REGIONS[id], 11)}
              className="fs-map-chip shrink-0 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer"
            >
              {t(`map.regions.${id}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Basemap switch + legend */}
      <div className="absolute top-3 right-3 z-10 hidden sm:flex flex-col items-end gap-2">
        <div className="fs-map-panel rounded-xl p-1 flex" role="group" aria-label={t('map.basemapLabel')}>
          {(['satellite', 'map'] as Basemap[]).map((b) => {
            const active = basemap === b;
            const Icon = b === 'satellite' ? Satellite : MapIcon;
            return (
              <button
                key={b}
                type="button"
                aria-pressed={active}
                onClick={() => onBasemapChange(b)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                  active ? 'bg-cf-hero text-cf-text' : 'text-cf-muted hover:text-cf-text'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t(`map.basemap.${b}`)}
              </button>
            );
          })}
        </div>
        {/* Same look as the Satellite/Map switch: a panel holding a chip that lights up when on */}
        <div className={`fs-map-panel rounded-xl p-1 flex ${showParcels ? 'is-on-cadastre' : ''}`}>
          <button
            type="button"
            aria-pressed={showParcels}
            onClick={onToggleParcels}
            title={t('map.cadastre.toggleHint')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
              showParcels ? 'text-cf-text' : 'text-cf-muted hover:text-cf-text'
            }`}
          >
            <LandPlot className="w-3.5 h-3.5" />
            {t('map.cadastre.toggle')}
            {showParcels && parcelStatus === 'loading' && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cf-muted" />
            )}
          </button>
        </div>
        {showParcels && (parcelStatus === 'zoom' || parcelStatus === 'error') && (
          <p className="fs-map-panel rounded-lg px-3 py-1.5 text-xs text-left text-cf-muted max-w-[15rem]" aria-live="polite">
            {parcelStatus === 'zoom' ? t('map.cadastre.zoomHint') : t('map.cadastre.unavailable')}
          </p>
        )}

        <div className={`fs-map-panel rounded-xl p-1 flex ${showWells ? 'is-on-wells' : ''}`}>
          <button
            type="button"
            aria-pressed={showWells}
            onClick={onToggleWells}
            disabled={wellsLocked}
            title={t('map.wells.toggleHint')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:cursor-default ${
              showWells ? 'text-cf-text' : 'text-cf-muted hover:text-cf-text'
            }`}
          >
            <Droplets className="w-3.5 h-3.5" />
            {t('map.wells.toggle')}
            {showWells && wellStatus === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-cf-muted" />}
          </button>
        </div>
        {showWells && (wellStatus === 'zoom' || wellStatus === 'error') && (
          <p className="fs-map-panel rounded-lg px-3 py-1.5 text-xs text-left text-cf-muted max-w-[15rem]" aria-live="polite">
            {wellStatus === 'zoom' ? t('map.wells.zoomHint') : t('map.wells.unavailable')}
          </p>
        )}
        <div className="fs-map-panel rounded-xl px-3 py-2 text-xs text-cf-muted space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-sm border-2 border-sage bg-sage/30" aria-hidden="true" />
            {t('map.legend.yours')}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-sm border border-dashed border-cf-muted fs-hatch" aria-hidden="true" />
            {t('map.legend.others')}
          </div>
          {showParcels && (
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-sm border border-[#7fd3f7]" aria-hidden="true" />
              {t('map.legend.parcels')}
            </div>
          )}
          {showWells &&
            (['active', 'inactive', 'unknown'] as const).map((st) => (
              <div key={st} className="flex items-center gap-2">
                <span
                  className="w-3 h-3 mx-px rounded-full border border-cf-text/30"
                  style={{ backgroundColor: WELL_COLORS[st] }}
                  aria-hidden="true"
                />
                {t(`map.wells.legend.${st}`)}
              </div>
            ))}
        </div>
      </div>

      {/* Compact basemap switch on phones */}
      <button
        type="button"
        onClick={() => onBasemapChange(basemap === 'satellite' ? 'map' : 'satellite')}
        className="sm:hidden absolute top-3 right-3 z-10 fs-map-panel rounded-xl p-3 text-cf-text cursor-pointer"
        aria-label={t('map.basemapLabel')}
      >
        {basemap === 'satellite' ? <MapIcon className="w-5 h-5" /> : <Satellite className="w-5 h-5" />}
      </button>

      {/* Compact Cadastre switch on phones */}
      <div className={`sm:hidden absolute top-[4.25rem] right-3 z-10 fs-map-panel rounded-xl p-1 ${showParcels ? 'is-on-cadastre' : ''}`}>
        <button
          type="button"
          aria-pressed={showParcels}
          onClick={onToggleParcels}
          className="p-2 rounded-lg cursor-pointer transition-colors text-cf-text"
          aria-label={t('map.cadastre.toggle')}
        >
          {showParcels && parcelStatus === 'loading' ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <LandPlot className="w-5 h-5" />
          )}
        </button>
      </div>
      {/* Compact water points switch on phones */}
      <div className={`sm:hidden absolute top-[7.5rem] right-3 z-10 fs-map-panel rounded-xl p-1 ${showWells ? 'is-on-wells' : ''}`}>
        <button
          type="button"
          aria-pressed={showWells}
          onClick={onToggleWells}
          disabled={wellsLocked}
          className="p-2 rounded-lg cursor-pointer transition-colors text-cf-text"
          aria-label={t('map.wells.toggle')}
        >
          {showWells && wellStatus === 'loading' ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Droplets className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="sm:hidden absolute bottom-12 left-3 right-16 z-10 flex flex-col items-start gap-1.5 pointer-events-none">
        {showParcels && (parcelStatus === 'zoom' || parcelStatus === 'error') && (
          <p className="fs-map-panel rounded-lg px-2.5 py-1.5 text-xs text-left text-cf-muted">
            {parcelStatus === 'zoom' ? t('map.cadastre.zoomHint') : t('map.cadastre.unavailable')}
          </p>
        )}
        {showWells && (wellStatus === 'zoom' || wellStatus === 'error') && (
          <p className="fs-map-panel rounded-lg px-2.5 py-1.5 text-xs text-left text-cf-muted">
            {wellStatus === 'zoom' ? t('map.wells.zoomHint') : t('map.wells.unavailable')}
          </p>
        )}
      </div>
    </>
  );
};
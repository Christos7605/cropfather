import type { LngLatBoundsLike, RasterSourceSpecification } from 'maplibre-gl';

// Vector basemap: OpenFreeMap (OpenStreetMap data, free, no key)
export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// Name of the vector source inside that style (used for the building check)
export const VECTOR_SOURCE_ID = 'openmaptiles';

// Satellite imagery.
// With VITE_ARCGIS_API_KEY set: Esri World Imagery (sub-metre, best for tracing fields;
// needs a free ArcGIS developer account). Without it: EOX Sentinel-2 cloudless, built
// from ESA Copernicus Sentinel-2 data at 10 m (non-commercial use, attribution required).
const ARCGIS_KEY = (import.meta.env.VITE_ARCGIS_API_KEY as string | undefined)?.trim();

export const SATELLITE_SOURCE: RasterSourceSpecification = ARCGIS_KEY
  ? {
      type: 'raster',
      tiles: [
        `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(ARCGIS_KEY)}`,
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }
  : {
      type: 'raster',
      tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
      tileSize: 256,
      maxzoom: 15,
      attribution:
        '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)',
    };

export const SATELLITE_IS_HIGH_RES = Boolean(ARCGIS_KEY);

// Greece first and bounds are [west, south, east, north]
export type RegionId = 'greece' | 'thessaly' | 'macedonia' | 'thrace' | 'sterea' | 'peloponnese' | 'crete';

export const REGIONS: Record<RegionId, LngLatBoundsLike> = {
  greece: [19.2, 34.7, 29.8, 41.8],
  thessaly: [21.1, 38.9, 23.3, 40.1],
  macedonia: [21.9, 39.9, 24.1, 41.3],
  thrace: [24.6, 40.7, 26.65, 41.75],
  sterea: [21.4, 37.95, 24.65, 39.3],
  peloponnese: [21.1, 36.35, 23.55, 38.35],
  crete: [23.4, 34.8, 26.4, 35.75],
};

export const REGION_ORDER: RegionId[] = ['greece', 'thessaly', 'macedonia', 'thrace', 'sterea', 'peloponnese', 'crete'];

// Zoom thresholds
export const MIN_DRAW_ZOOM = 14; // Min zoom required for individual fields to be clearly visible from here
export const MIN_NEIGHBOUR_ZOOM = 11; // Min zoom required to fetch other farmers' outlines from here
export const MIN_BUILDING_CHECK_ZOOM = 14; // Min zoom required for building outlines to exist in the tiles from here
export const MIN_PARCEL_ZOOM = 15; // Min zoom required for cadastral parcels to be loaded from here (they are dense)
export const MIN_WELL_ZOOM = 11; // Min zoom required for water points to be loaded from here

// Colours
export const COLORS = {
  own: '#9cc58a',
  selected: '#e3b55b',
  draw: '#9dbcf2',
  neighbour: '#c0ccc5',
  trimmed: '#e3b55b',
  parcel: '#7fd3f7',
} as const;

// Water point status colours: green = active, red = inactive, yellow = status not recorded
export const WELL_COLORS = {
  active: '#5ad17f',
  inactive: '#ef6461',
  unknown: '#f2c94c',
} as const;
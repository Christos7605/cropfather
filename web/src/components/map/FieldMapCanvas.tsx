import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  TerraDrawModeUndoRedo,
  TerraDrawUndoRedoKeyboardShortcuts,
  type GeoJSONStoreFeatures,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import turfArea from '@turf/area';
import booleanIntersects from '@turf/boolean-intersects';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import {
  CADASTRE_ATTRIBUTION,
  MAX_CELLS_PER_VIEW,
  ParcelOutlineCache,
  type ParcelFeature,
} from '../../lib/cadastre';
import type { FieldRecord } from '../../lib/fields';
import { fetchNeighbourFields, roundPolygon } from '../../lib/fields';
import { fetchWaterPointsInView, WATER_POINTS_ATTRIBUTION, type WaterPoint } from '../../lib/waterPoints';
import {
  BASE_STYLE_URL,
  COLORS,
  MIN_BUILDING_CHECK_ZOOM,
  MIN_NEIGHBOUR_ZOOM,
  MIN_PARCEL_ZOOM,
  MIN_WELL_ZOOM,
  REGIONS,
  SATELLITE_SOURCE,
  VECTOR_SOURCE_ID,
  WELL_COLORS,
} from '../../lib/mapConfig';
import { isInGreece, outsideGreeceMask, polygonInGreece, GREECE } from '../../lib/greece';
import {
  createHatchPattern,
  findSnapPoint,
  indexPolygons,
  isInsideAny,
  polygonBBox,
  ringBBox,
  type IndexedRing,
} from './geo';

export type Basemap = 'satellite' | 'map';
// pickWell: choosing the water point of a field (only water points can be clicked)
export type CanvasMode = 'browse' | 'drawing' | 'shape' | 'pickWell';
// off: layer hidden - zoom: zoomed out too far - loading - ready - error: service unavailable
export type ParcelStatus = 'off' | 'zoom' | 'loading' | 'ready' | 'error';

export interface BuildingCheck {
  buildings: number;
  builtUp: boolean;
}

export interface FieldMapHandle {
  startDrawing: () => void;
  cancelDrawing: () => void;
  undo: () => void;
  // Shows a polygon as an editable shape (drag corners, add corners from midpoints)
  loadShape: (polygon: Polygon) => void;
  // Replaces the editable shape with the trimmed boundary from the database
  replaceShape: (polygon: Polygon) => void;
  clearShape: () => void;
  fitBounds: (bounds: LngLatBoundsLike, maxZoom?: number) => void;
  fitPolygons: (polygons: Polygon[], maxZoom?: number) => void;
  zoomInForDrawing: () => void;
  // Best-effort check for buildings / built-up land inside a shape or null when the map is too far out)
  checkBuildings: (polygon: Polygon) => BuildingCheck | null;
}

interface Props {
  fields: FieldRecord[];
  selectedId: string | null;
  // Field being edited: hidden from the field layer while its shape is editable
  editingId: string | null;
  mode: CanvasMode;
  basemap: Basemap;
  language: 'el' | 'en';
  neighbourTitle: string;
  neighbourDesc: string;
  // Hover text for the dimmed area outside Greece
  outsideMessage: string;
  // Show Hellenic Cadastre parcel outlines
  showParcels: boolean;
  // Parcel chosen by the farmer, outlined until they use or dismiss it
  highlightParcel: Polygon | null;
  onParcelClick: (lng: number, lat: number) => void;
  onParcelStatus: (status: ParcelStatus) => void;
  // Show the ΕΜΣΥ water points (forced on while choosing a field's water source)
  showWells: boolean;
  // Dashed line from a field to its water point, and a ring around the point
  wellLink: { from: [number, number]; to: WaterPoint } | null;
  onWellClick: (point: WaterPoint) => void;
  onWellStatus: (status: ParcelStatus) => void;
  // Text for the hover card of a water point, in the current language
  describeWell: (point: WaterPoint) => { title: string; lines: string[] };
  onFieldClick: (id: string) => void;
  onDrawProgress: (areaHa: number) => void;
  onDrawComplete: (polygon: Polygon) => void;
  onShapeChange: (polygon: Polygon) => void;
  onBlockedPoint: () => void;
  onOutsidePoint: () => void;
  onZoomChange: (zoom: number) => void;
  onCanUndoChange: (canUndo: boolean) => void;
  onReady: () => void;
}

setWorkerUrl(maplibreWorkerUrl);

const SRC_OUTSIDE = 'fs-outside';
const SRC_GREECE = 'fs-greece';
const SRC_FIELDS = 'fs-fields';
const SRC_NEIGHBOURS = 'fs-neighbours';
const SRC_SATELLITE = 'fs-satellite';
const SRC_PARCELS = 'fs-parcels';
const SRC_PARCEL_PICK = 'fs-parcel-pick';
const SRC_WELLS = 'fs-wells';
const SRC_WELL_LINK = 'fs-well-link';
const HATCH_IMAGE = 'fs-hatch';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function ringsOf(features: ParcelFeature[]): IndexedRing[] {
  const out: IndexedRing[] = [];
  for (const f of features) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polygons) {
      for (const ring of rings) if (ring.length >= 4) out.push({ ring, bbox: ringBBox(ring) });
    }
  }
  return out;
}

const asPolygon = (feature: GeoJSONStoreFeatures | undefined): Polygon | null =>
  feature && feature.geometry.type === 'Polygon' ? (feature.geometry as Polygon) : null;

export const FieldMapCanvas = forwardRef<FieldMapHandle, Props>(function FieldMapCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const readyRef = useRef(false);
  const shapeIdRef = useRef<string | number | null>(null);
  const baseLayerIdsRef = useRef<{ id: string; type: string; textField?: unknown }[]>([]);

  // Latest props for map/draw event handlers registered once
  const propsRef = useRef(props);
  propsRef.current = props;

  // Shapes the farmer may not draw into: other farmers' land and their own other fields
  const neighboursRef = useRef<Polygon[]>([]);
  const blockedRef = useRef<IndexedRing[]>([]);
  const lastBlockedNoticeRef = useRef(0);

  // Cadastre parcels: edges to snap to (not blocked: anyone may draw on a parcel)
  const parcelCacheRef = useRef(new ParcelOutlineCache());
  const parcelRingsRef = useRef<IndexedRing[]>([]);
  const snapRingsRef = useRef<IndexedRing[]>([]);
  const loadParcelsRef = useRef<() => void>(() => {});

  // Water points currently on the map, by id (for the hover card and clicks)
  const wellsByIdRef = useRef(new Map<number, WaterPoint>());
  const loadWellsRef = useRef<() => void>(() => {});

  const rebuildSnap = () => {
    snapRingsRef.current = propsRef.current.showParcels
      ? blockedRef.current.concat(parcelRingsRef.current)
      : blockedRef.current;
  };

  const rebuildBlocked = () => {
    const own = propsRef.current.fields
      .filter((f) => f.id !== propsRef.current.editingId)
      .map((f) => f.geometry);
    blockedRef.current = indexPolygons([...neighboursRef.current, ...own]);
    rebuildSnap();
  };

  // -------------------------------------------------------------------------
  // Map + Terra Draw setup (once)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: BASE_STYLE_URL,
      bounds: REGIONS.greece,
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        fitBoundsOptions: { maxZoom: 16 },
        trackUserLocation: false,
      }),
      'bottom-right',
    );
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    let neighbourTimer: number | undefined;
    let neighbourSeq = 0;
    let parcelTimer: number | undefined;
    let parcelController: AbortController | null = null;
    let hoveredParcel: string | number | undefined;
    let wellTimer: number | undefined;
    let wellSeq = 0;
    let hoveredWell: string | number | undefined;
    let popup: Popup | null = null;
    let hoveredId: string | number | undefined;
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    const loadNeighbours = () => {
      window.clearTimeout(neighbourTimer);
      neighbourTimer = window.setTimeout(async () => {
        const seq = ++neighbourSeq;
        const source = map.getSource(SRC_NEIGHBOURS) as GeoJSONSource | undefined;
        if (!source) return;
        if (map.getZoom() < MIN_NEIGHBOUR_ZOOM) {
          neighboursRef.current = [];
          rebuildBlocked();
          source.setData(EMPTY);
          return;
        }
        // Query at most ~1.2° around the centre (the database refuses larger boxes)
        const b = map.getBounds();
        const c = map.getCenter();
        const half = 0.6;
        const west = Math.max(b.getWest(), c.lng - half);
        const east = Math.min(b.getEast(), c.lng + half);
        const south = Math.max(b.getSouth(), c.lat - half);
        const north = Math.min(b.getNorth(), c.lat + half);
        try {
          const polygons = await fetchNeighbourFields(west, south, east, north);
          if (seq !== neighbourSeq) return;
          neighboursRef.current = polygons;
          rebuildBlocked();
          source.setData({
            type: 'FeatureCollection',
            features: polygons.map((geometry) => ({ type: 'Feature', properties: {}, geometry })),
          });
        } catch {
          // Outlines are a convenience; the database still blocks overlaps on save
        }
      }, 350);
    };

    const loadParcels = () => {
      window.clearTimeout(parcelTimer);
      parcelTimer = window.setTimeout(async () => {
        const source = map.getSource(SRC_PARCELS) as GeoJSONSource | undefined;
        if (!source) return;
        parcelController?.abort();
        parcelController = null;
        if (!propsRef.current.showParcels) {
          parcelRingsRef.current = [];
          rebuildSnap();
          source.setData(EMPTY);
          propsRef.current.onParcelStatus('off');
          return;
        }
        const b = map.getBounds();
        const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
        if (map.getZoom() < MIN_PARCEL_ZOOM || ParcelOutlineCache.cellCount(bounds) > MAX_CELLS_PER_VIEW) {
          propsRef.current.onParcelStatus('zoom'); // keep what is loaded; the layer hides itself
          return;
        }
        const controller = new AbortController();
        parcelController = controller;
        propsRef.current.onParcelStatus('loading');
        try {
          const data = await parcelCacheRef.current.getView(bounds, controller.signal);
          if (controller.signal.aborted) return;
          source.setData(data);
          parcelRingsRef.current = ringsOf(data.features);
          rebuildSnap();
          propsRef.current.onParcelStatus('ready');
        } catch {
          if (controller.signal.aborted) return;
          propsRef.current.onParcelStatus('error');
        }
      }, 300);
    };
    loadParcelsRef.current = loadParcels;

    const loadWells = () => {
      window.clearTimeout(wellTimer);
      wellTimer = window.setTimeout(async () => {
        const seq = ++wellSeq;
        const source = map.getSource(SRC_WELLS) as GeoJSONSource | undefined;
        if (!source) return;
        if (!propsRef.current.showWells) {
          wellsByIdRef.current = new Map();
          source.setData(EMPTY);
          propsRef.current.onWellStatus('off');
          return;
        }
        if (map.getZoom() < MIN_WELL_ZOOM) {
          propsRef.current.onWellStatus('zoom'); // keep what is loaded; the layer hides itself
          return;
        }
        // At most ~0.8° around the centre (the database refuses larger boxes)
        const b = map.getBounds();
        const c = map.getCenter();
        const half = 0.4;
        propsRef.current.onWellStatus('loading');
        try {
          const points = await fetchWaterPointsInView(
            Math.max(b.getWest(), c.lng - half),
            Math.max(b.getSouth(), c.lat - half),
            Math.min(b.getEast(), c.lng + half),
            Math.min(b.getNorth(), c.lat + half),
          );
          if (seq !== wellSeq) return;
          wellsByIdRef.current = new Map(points.map((p) => [p.id, p]));
          source.setData({
            type: 'FeatureCollection',
            features: points.map((p) => ({
              type: 'Feature',
              id: p.id,
              properties: { id: p.id, status: p.status },
              geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
            })),
          });
          propsRef.current.onWellStatus('ready');
        } catch {
          if (seq !== wellSeq) return;
          propsRef.current.onWellStatus('error');
        }
      }, 300);
    };
    loadWellsRef.current = loadWells;

    map.on('load', () => {
      const style = map.getStyle();
      baseLayerIdsRef.current = style.layers.map((l) => ({
        id: l.id,
        type: l.type,
        textField: l.type === 'symbol' ? l.layout?.['text-field'] : undefined,
      }));
      const firstSymbolId = style.layers.find((l) => l.type === 'symbol')?.id;
      const firstNonBackground = style.layers.find((l) => l.type !== 'background')?.id;

      // Satellite imagery sits just above the background, below everything else
      map.addSource(SRC_SATELLITE, SATELLITE_SOURCE);
      map.addLayer(
        { id: SRC_SATELLITE, type: 'raster', source: SRC_SATELLITE, paint: { 'raster-fade-duration': 150 } },
        firstNonBackground,
      );

      map.addImage(HATCH_IMAGE, createHatchPattern());

      // Greece is open. Everywhere else is dimmed, with the country outline drawn on top.
      map.addSource(SRC_OUTSIDE, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: outsideGreeceMask() },
      });
      map.addLayer(
        {
          id: 'fs-outside-fill',
          type: 'fill',
          source: SRC_OUTSIDE,
          paint: { 'fill-color': '#1b2921', 'fill-opacity': 0.45 },
        },
        firstSymbolId,
      );
      map.addSource(SRC_GREECE, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: GREECE },
      });
      map.addLayer(
        {
          id: 'fs-greece-casing',
          type: 'line',
          source: SRC_GREECE,
          paint: { 'line-color': '#1b2921', 'line-width': 4 },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-greece-line',
          type: 'line',
          source: SRC_GREECE,
          paint: { 'line-color': '#f7f5ee', 'line-width': 2 },
        },
        firstSymbolId,
      );

      map.on('mousemove', 'fs-outside-fill', (e: MapLayerMouseEvent) => {
        const html = document.createElement('div');
        const text = document.createElement('strong');
        text.textContent = propsRef.current.outsideMessage;
        html.append(text);
        if (!popup) {
          popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fs-popup', maxWidth: '260px', offset: 12 });
        }
        popup.setLngLat(e.lngLat).setDOMContent(html).addTo(map);
        map.getCanvas().style.cursor = 'not-allowed';
      });
      map.on('mouseleave', 'fs-outside-fill', () => {
        popup?.remove();
        if (propsRef.current.mode === 'browse') map.getCanvas().style.cursor = '';
      });

      // Hellenic Cadastre parcels: thin light-blue outlines under everything the farmer owns
      map.addSource(SRC_PARCELS, { type: 'geojson', data: EMPTY, promoteId: 'pid', attribution: CADASTRE_ATTRIBUTION });
      map.addLayer(
        {
          id: 'fs-parcels-fill',
          type: 'fill',
          source: SRC_PARCELS,
          minzoom: MIN_PARCEL_ZOOM - 1,
          layout: { visibility: 'none' },
          paint: {
            'fill-color': COLORS.parcel,
            // Almost transparent, so the parcel can still be hovered and clicked
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.18, 0.01],
          },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-parcels-line',
          type: 'line',
          source: SRC_PARCELS,
          minzoom: MIN_PARCEL_ZOOM - 1,
          layout: { visibility: 'none' },
          paint: {
            'line-color': COLORS.parcel,
            'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1, 19, 1.8],
            // Parcels still under posting (not final) are drawn fainter
            'line-opacity': ['case', ['==', ['get', 'stage'], 'posted'], 0.55, 0.9],
          },
        },
        firstSymbolId,
      );

      // Other farmers' land: hatched, clearly "taken"
      map.addSource(SRC_NEIGHBOURS, { type: 'geojson', data: EMPTY });
      map.addLayer(
        {
          id: 'fs-neighbours-fill',
          type: 'fill',
          source: SRC_NEIGHBOURS,
          paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.9 },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-neighbours-line',
          type: 'line',
          source: SRC_NEIGHBOURS,
          paint: { 'line-color': COLORS.neighbour, 'line-width': 1.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 },
        },
        firstSymbolId,
      );

      // The farmer's own fields
      map.addSource(SRC_FIELDS, { type: 'geojson', data: EMPTY, promoteId: 'id' });
      map.addLayer(
        {
          id: 'fs-fields-fill',
          type: 'fill',
          source: SRC_FIELDS,
          paint: {
            'fill-color': ['case', ['get', 'selected'], COLORS.selected, COLORS.own],
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.42,
              ['get', 'selected'],
              0.34,
              0.24,
            ],
          },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-fields-line',
          type: 'line',
          source: SRC_FIELDS,
          paint: {
            'line-color': ['case', ['get', 'selected'], COLORS.selected, COLORS.own],
            'line-width': ['case', ['get', 'selected'], 3, 2],
          },
        },
        firstSymbolId,
      );
      // The parcel the farmer clicked
      map.addSource(SRC_PARCEL_PICK, { type: 'geojson', data: EMPTY });
      map.addLayer(
        {
          id: 'fs-parcel-pick-fill',
          type: 'fill',
          source: SRC_PARCEL_PICK,
          paint: { 'fill-color': COLORS.selected, 'fill-opacity': 0.22 },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-parcel-pick-line',
          type: 'line',
          source: SRC_PARCEL_PICK,
          paint: { 'line-color': COLORS.selected, 'line-width': 3 },
        },
        firstSymbolId,
      );

      // Link between a field and its water point
      map.addSource(SRC_WELL_LINK, { type: 'geojson', data: EMPTY });
      map.addLayer(
        {
          id: 'fs-well-link-line',
          type: 'line',
          source: SRC_WELL_LINK,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': COLORS.selected, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        firstSymbolId,
      );

      // ΕΜΣΥ water points: green active, red inactive, yellow status not recorded
      map.addSource(SRC_WELLS, { type: 'geojson', data: EMPTY, promoteId: 'id', attribution: WATER_POINTS_ATTRIBUTION });
      map.addLayer(
        {
          id: 'fs-wells-circle',
          type: 'circle',
          source: SRC_WELLS,
          minzoom: MIN_WELL_ZOOM - 0.5,
          layout: { visibility: 'none' },
          paint: {
            'circle-color': [
              'match',
              ['get', 'status'],
              'active',
              WELL_COLORS.active,
              'inactive',
              WELL_COLORS.inactive,
              WELL_COLORS.unknown,
            ],
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              12,
              ['case', ['boolean', ['feature-state', 'hover'], false], 8, 6],
              16,
              ['case', ['boolean', ['feature-state', 'hover'], false], 12, 9],
            ],
            'circle-stroke-color': '#1a2325',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 1.5],
            'circle-opacity': 0.95,
          },
        },
        firstSymbolId,
      );
      map.addLayer(
        {
          id: 'fs-well-link-ring',
          type: 'circle',
          source: SRC_WELL_LINK,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 11,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': COLORS.selected,
            'circle-stroke-width': 3,
          },
        },
        firstSymbolId,
      );

      map.addLayer({
        id: 'fs-fields-label',
        type: 'symbol',
        source: SRC_FIELDS,
        minzoom: 13,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 13,
          'text-max-width': 10,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#1a2325', 'text-halo-width': 1.6 },
      });

      // Neighbour hint on hover (while browsing)
      map.on('mousemove', 'fs-neighbours-fill', (e: MapLayerMouseEvent) => {
        if (propsRef.current.mode !== 'browse') return;
        const { neighbourTitle, neighbourDesc } = propsRef.current;
        const html = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = neighbourTitle;
        const desc = document.createElement('p');
        desc.textContent = neighbourDesc;
        html.append(title, desc);
        if (!popup) {
          popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fs-popup', maxWidth: '260px', offset: 12 });
        }
        popup.setLngLat(e.lngLat).setDOMContent(html).addTo(map);
        map.getCanvas().style.cursor = 'not-allowed';
      });
      map.on('mouseleave', 'fs-neighbours-fill', () => {
        popup?.remove();
        if (propsRef.current.mode === 'browse') map.getCanvas().style.cursor = '';
      });

      // Own fields that we can hover to highlight and click to select
      map.on('mousemove', 'fs-fields-fill', (e: MapLayerMouseEvent) => {
        if (propsRef.current.mode !== 'browse') return;
        const id = e.features?.[0]?.id;
        if (id === undefined) return;
        if (hoveredId !== undefined && hoveredId !== id) {
          map.setFeatureState({ source: SRC_FIELDS, id: hoveredId }, { hover: false });
        }
        hoveredId = id;
        map.setFeatureState({ source: SRC_FIELDS, id }, { hover: true });
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'fs-fields-fill', () => {
        if (hoveredId !== undefined) map.setFeatureState({ source: SRC_FIELDS, id: hoveredId }, { hover: false });
        hoveredId = undefined;
        if (propsRef.current.mode === 'browse') map.getCanvas().style.cursor = '';
      });
      map.on('click', 'fs-fields-fill', (e: MapLayerMouseEvent) => {
        if (propsRef.current.mode !== 'browse') return;
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === 'string') propsRef.current.onFieldClick(id);
      });

      // Water points: hover card everywhere except while drawing; click only while choosing
      const clearWellHover = () => {
        if (hoveredWell !== undefined) map.setFeatureState({ source: SRC_WELLS, id: hoveredWell }, { hover: false });
        hoveredWell = undefined;
      };
      map.on('mousemove', 'fs-wells-circle', (e: MapLayerMouseEvent) => {
        const p = propsRef.current;
        if (p.mode === 'drawing' || p.mode === 'shape') return;
        const id = e.features?.[0]?.id;
        const point = typeof id === 'number' ? wellsByIdRef.current.get(id) : undefined;
        if (id === undefined || !point) return;
        if (id !== hoveredWell) {
          clearWellHover();
          hoveredWell = id;
          map.setFeatureState({ source: SRC_WELLS, id }, { hover: true });
        }
        const { title, lines } = p.describeWell(point);
        const html = document.createElement('div');
        const heading = document.createElement('strong');
        heading.textContent = title;
        html.append(heading);
        for (const line of lines) {
          const row = document.createElement('p');
          row.textContent = line;
          html.append(row);
        }
        if (!popup) {
          popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fs-popup', maxWidth: '280px', offset: 12 });
        }
        popup.setLngLat([point.lon, point.lat]).setDOMContent(html).addTo(map);
        map.getCanvas().style.cursor = p.mode === 'pickWell' ? 'pointer' : '';
      });
      map.on('mouseleave', 'fs-wells-circle', () => {
        clearWellHover();
        popup?.remove();
        if (propsRef.current.mode !== 'drawing') map.getCanvas().style.cursor = '';
      });
      map.on('click', 'fs-wells-circle', (e: MapLayerMouseEvent) => {
        if (propsRef.current.mode !== 'pickWell') return;
        const id = e.features?.[0]?.id;
        const point = typeof id === 'number' ? wellsByIdRef.current.get(id) : undefined;
        if (point) propsRef.current.onWellClick(point);
      });

      // Cadastre parcels: hover highlight and click to pick (only while browsing)
      const overOwnOrTaken = (point: { x: number; y: number }) =>
        map.queryRenderedFeatures([point.x, point.y], {
          layers: ['fs-fields-fill', 'fs-neighbours-fill', 'fs-wells-circle'],
        }).length > 0;

      const clearParcelHover = () => {
        if (hoveredParcel !== undefined) map.setFeatureState({ source: SRC_PARCELS, id: hoveredParcel }, { hover: false });
        hoveredParcel = undefined;
      };

      map.on('mousemove', 'fs-parcels-fill', (e: MapLayerMouseEvent) => {
        const p = propsRef.current;
        if (p.mode !== 'browse' || !p.showParcels || overOwnOrTaken(e.point)) {
          clearParcelHover();
          return;
        }
        const id = e.features?.[0]?.id;
        if (id === undefined || id === hoveredParcel) return;
        clearParcelHover();
        hoveredParcel = id;
        map.setFeatureState({ source: SRC_PARCELS, id }, { hover: true });
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'fs-parcels-fill', () => {
        clearParcelHover();
        if (propsRef.current.mode === 'browse') map.getCanvas().style.cursor = '';
      });

      map.on('click', (e) => {
        const p = propsRef.current;
        if (p.mode !== 'browse' || !p.showParcels || map.getZoom() < MIN_PARCEL_ZOOM) return;
        if (!isInGreece(e.lngLat.lng, e.lngLat.lat)) return;
        if (overOwnOrTaken(e.point)) return; // own fields open their details whereas taken land cannot be picked
        p.onParcelClick(e.lngLat.lng, e.lngLat.lat);
      });

      map.on('moveend', loadNeighbours);
      map.on('moveend', loadParcels);
      map.on('moveend', loadWells);
      map.on('zoomend', () => propsRef.current.onZoomChange(map.getZoom()));

      // Terra draw
      const snapToFields = (event: { lng: number; lat: number }, context: {
        project: (lng: number, lat: number) => { x: number; y: number };
        unproject: (x: number, y: number) => { lng: number; lat: number };
      }): Position | undefined =>
        findSnapPoint(event.lng, event.lat, snapRingsRef.current, context.project, context.unproject);

      const notifyLimit = (kind: 'blocked' | 'outside') => {
        const now = Date.now();
        if (now - lastBlockedNoticeRef.current <= 1500) return;
        lastBlockedNoticeRef.current = now;
        if (kind === 'outside') propsRef.current.onOutsidePoint();
        else propsRef.current.onBlockedPoint();
      };

      const rejectBlockedCorners = (feature: GeoJSONStoreFeatures, context: { updateType: unknown }) => {
        // Moving the mouse is always allowed whereas placing or moving a corner is checked
        if (String(context.updateType) === 'provisional') return { valid: true };
        const polygon = asPolygon(feature);
        if (!polygon) return { valid: true };
        const ring = polygon.coordinates[0] ?? [];
        const outside = ring.length >= 4 ? !polygonInGreece(polygon) : ring.some(([lng, lat]) => !isInGreece(lng, lat));
        if (outside) {
          notifyLimit('outside');
          return { valid: false, reason: 'outside' };
        }
        for (const corner of ring) {
          if (isInsideAny(corner, blockedRef.current)) {
            notifyLimit('blocked');
            return { valid: false, reason: 'blocked' };
          }
        }
        return { valid: true };
      };

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 7 }),
        modes: [
          new TerraDrawPolygonMode({
            snapping: { toCoordinate: true, toCustom: snapToFields },
            validation: rejectBlockedCorners,
            styles: {
              fillColor: COLORS.draw,
              fillOpacity: 0.18,
              outlineColor: COLORS.draw,
              outlineWidth: 2.5,
              closingPointColor: '#ffffff',
              closingPointWidth: 7,
              closingPointOutlineColor: COLORS.draw,
              closingPointOutlineWidth: 3,
              snappingPointColor: COLORS.selected,
              snappingPointWidth: 6,
              snappingPointOutlineColor: '#ffffff',
              snappingPointOutlineWidth: 2,
              coordinatePointColor: '#ffffff',
              coordinatePointWidth: 4,
              coordinatePointOutlineColor: COLORS.draw,
              coordinatePointOutlineWidth: 2,
            },
          }),
          new TerraDrawSelectMode({
            allowManualDeselection: false,
            keyEvents: { deselect: null, delete: null, rotate: null, scale: null },
            flags: {
              polygon: {
                feature: {
                  draggable: false,
                  validation: rejectBlockedCorners,
                  coordinates: {
                    draggable: true,
                    midpoints: true,
                    deletable: true,
                    snappable: { toCustom: snapToFields },
                  },
                },
              },
            },
            styles: {
              selectedPolygonColor: COLORS.draw,
              selectedPolygonFillOpacity: 0.18,
              selectedPolygonOutlineColor: COLORS.draw,
              selectedPolygonOutlineWidth: 2.5,
              selectionPointColor: '#ffffff',
              selectionPointWidth: 6,
              selectionPointOutlineColor: COLORS.draw,
              selectionPointOutlineWidth: 2.5,
              midPointColor: COLORS.draw,
              midPointWidth: 4,
              midPointOutlineColor: '#ffffff',
              midPointOutlineWidth: 1.5,
            },
          }),
        ],
        undoRedo: {
          modeLevel: new TerraDrawModeUndoRedo(),
          keyboardShortcuts: new TerraDrawUndoRedoKeyboardShortcuts(),
        },
      });
      draw.start();
      draw.setMode('static');
      drawRef.current = draw;

      draw.on('change', (ids) => {
        const mode = draw.getMode();
        if (mode === 'polygon') {
          const drawing = draw.getSnapshot().find((f) => f.properties.mode === 'polygon');
          const polygon = asPolygon(drawing);
          const first = polygon?.coordinates[0]?.[0];
          // Terra Draw does not validate the very first corner, so check it here and restart
          // the drawing if it was placed on land that is already registered
          if (first && !isInGreece(first[0], first[1])) {
            window.setTimeout(() => {
              draw.setMode('static');
              draw.clear();
              draw.clearUndoRedoHistory();
              draw.setMode('polygon');
              propsRef.current.onCanUndoChange(false);
              propsRef.current.onDrawProgress(0);
            }, 0);
            notifyLimit('outside');
            return;
          }
          if (first && isInsideAny(first, blockedRef.current)) {
            window.setTimeout(() => {
              draw.setMode('static');
              draw.clear();
              draw.clearUndoRedoHistory();
              draw.setMode('polygon');
              propsRef.current.onCanUndoChange(false);
              propsRef.current.onDrawProgress(0);
            }, 0);
            notifyLimit('blocked');
            return;
          }
          if (draw.getModeState() === 'drawing' && polygon && (polygon.coordinates[0]?.length ?? 0) >= 4) {
            propsRef.current.onDrawProgress(turfArea(polygon) / 10000);
          }
          return;
        }
        if (mode === 'select' && shapeIdRef.current !== null && ids.includes(shapeIdRef.current)) {
          const polygon = asPolygon(draw.getSnapshotFeature(shapeIdRef.current));
          if (polygon) propsRef.current.onShapeChange(polygon);
        }
      });

      draw.on('finish', (id, context) => {
        if (context.mode !== 'polygon') return;
        const polygon = asPolygon(draw.getSnapshotFeature(id));
        if (!polygon) return;
        shapeIdRef.current = id;
        draw.setMode('select');
        draw.selectFeature(id);
        propsRef.current.onCanUndoChange(false);
        propsRef.current.onDrawComplete(polygon);
      });

      draw.on('history', (event) => {
        propsRef.current.onCanUndoChange(draw.getMode() === 'polygon' && event.undoSize > 0);
      });

      readyRef.current = true;
      rebuildBlocked();
      applyParcelVisibility(propsRef.current.showParcels);
      applyWellVisibility(propsRef.current.showWells);
      applyBasemap(propsRef.current.basemap);
      applyLabelLanguage(propsRef.current.language);
      renderFields();
      loadNeighbours();
      loadParcels();
      loadWells();
      propsRef.current.onZoomChange(map.getZoom());
      propsRef.current.onReady();
    });

    return () => {
      window.clearTimeout(neighbourTimer);
      window.clearTimeout(parcelTimer);
      window.clearTimeout(wellTimer);
      parcelController?.abort();
      resizeObserver.disconnect();
      popup?.remove();
      readyRef.current = false;
      try {
        drawRef.current?.stop();
      } catch {
        // map may already be gone
      }
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop-driven updates
  const renderFields = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { fields, selectedId, editingId } = propsRef.current;
    const features: Feature[] = fields
      .filter((f) => f.id !== editingId)
      .map((f) => ({
        type: 'Feature',
        id: f.id,
        properties: { id: f.id, name: f.name, selected: f.id === selectedId },
        geometry: f.geometry,
      }));
    (map.getSource(SRC_FIELDS) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  };

  const applyBasemap = (basemap: Basemap) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const satellite = basemap === 'satellite';
    for (const layer of baseLayerIdsRef.current) {
      // Keep place names and road labels on top of the imagery
      if (layer.type === 'symbol') continue;
      if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', satellite ? 'none' : 'visible');
    }
    map.setLayoutProperty(SRC_SATELLITE, 'visibility', satellite ? 'visible' : 'none');
  };

  const applyParcelVisibility = (show: boolean) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    for (const id of ['fs-parcels-fill', 'fs-parcels-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    }
  };

  const applyWellVisibility = (show: boolean) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (map.getLayer('fs-wells-circle')) map.setLayoutProperty('fs-wells-circle', 'visibility', show ? 'visible' : 'none');
  };

  const applyLabelLanguage = (language: 'el' | 'en') => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    for (const layer of baseLayerIdsRef.current) {
      if (layer.type !== 'symbol' || !layer.textField) continue;
      if (!JSON.stringify(layer.textField).includes('name')) continue; // leave road numbers alone
      map.setLayoutProperty(layer.id, 'text-field', [
        'coalesce',
        ['get', `name:${language}`],
        ['get', 'name:latin'],
        ['get', 'name'],
      ]);
    }
  };

  useEffect(() => {
    rebuildBlocked();
    renderFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fields, props.selectedId, props.editingId]);

  useEffect(() => {
    applyBasemap(props.basemap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.basemap]);

  useEffect(() => {
    applyParcelVisibility(props.showParcels);
    rebuildSnap();
    loadParcelsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showParcels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const polygon = props.highlightParcel;
    (map.getSource(SRC_PARCEL_PICK) as GeoJSONSource | undefined)?.setData(
      polygon ? { type: 'Feature', properties: {}, geometry: polygon } : EMPTY,
    );
  }, [props.highlightParcel]);

  useEffect(() => {
    applyWellVisibility(props.showWells);
    loadWellsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showWells]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const link = props.wellLink;
    (map.getSource(SRC_WELL_LINK) as GeoJSONSource | undefined)?.setData(
      link
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: [link.from, [link.to.lon, link.to.lat]] },
              },
              { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [link.to.lon, link.to.lat] } },
            ],
          }
        : EMPTY,
    );
  }, [props.wellLink]);

  useEffect(() => {
    applyLabelLanguage(props.language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.language]);

  // API for the page
  useImperativeHandle(ref, () => {
    const clear = () => {
      const draw = drawRef.current;
      if (!draw) return;
      draw.setMode('static');
      draw.clear();
      draw.clearUndoRedoHistory();
      shapeIdRef.current = null;
    };

    const showShape = (input: Polygon) => {
      const draw = drawRef.current;
      if (!draw) return;
      clear();
      // Terra Draw refuses coordinates with more decimals than its precision (7)
      const polygon = roundPolygon(input);
      const id = draw.getFeatureId();
      const [result] = draw.addFeatures([
        { id, type: 'Feature', geometry: polygon, properties: { mode: 'polygon' } },
      ]);
      if (result && !result.valid) {
        console.warn('[FieldMap] shape could not be shown for editing:', result.reason);
        return;
      }
      shapeIdRef.current = id;
      draw.setMode('select');
      draw.selectFeature(id);
    };

    return {
      startDrawing: () => {
        const draw = drawRef.current;
        if (!draw) return;
        clear();
        draw.setMode('polygon');
      },
      cancelDrawing: clear,
      undo: () => {
        const draw = drawRef.current;
        if (draw && draw.canUndo()) draw.undo();
      },
      loadShape: showShape,
      replaceShape: (polygon) => {
        const draw = drawRef.current;
        const id = shapeIdRef.current;
        if (!draw || id === null || !draw.hasFeature(id)) {
          showShape(polygon);
          return;
        }
        draw.updateFeatureGeometry(id, roundPolygon(polygon));
      },
      clearShape: clear,
      fitBounds: (bounds, maxZoom = 16) => {
        mapRef.current?.fitBounds(bounds, { padding: 48, maxZoom, duration: 900 });
      },
      fitPolygons: (polygons, maxZoom = 17) => {
        const map = mapRef.current;
        if (!map || polygons.length === 0) return;
        let [w, s, e, n] = polygonBBox(polygons[0]);
        for (const p of polygons.slice(1)) {
          const [pw, ps, pe, pn] = polygonBBox(p);
          w = Math.min(w, pw);
          s = Math.min(s, ps);
          e = Math.max(e, pe);
          n = Math.max(n, pn);
        }
        map.fitBounds([w, s, e, n], { padding: 64, maxZoom, duration: 900 });
      },
      zoomInForDrawing: () => {
        const map = mapRef.current;
        if (!map) return;
        map.easeTo({ zoom: Math.max(map.getZoom(), 15), duration: 700 });
      },
      checkBuildings: (polygon) => {
        const map = mapRef.current;
        if (!map || !readyRef.current || map.getZoom() < MIN_BUILDING_CHECK_ZOOM) return null;
        if (!map.getSource(VECTOR_SOURCE_ID)) return null;
        const shape: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: polygon };
        const seen = new Set<string>();
        let buildings = 0;
        for (const f of map.querySourceFeatures(VECTOR_SOURCE_ID, { sourceLayer: 'building' })) {
          const key = f.id !== undefined ? String(f.id) : JSON.stringify(f.geometry).slice(0, 80);
          if (seen.has(key)) continue; // the same building can appear in two tiles
          try {
            if (booleanIntersects(shape, f as Feature)) {
              seen.add(key);
              buildings += 1;
            }
          } catch {
            // We ignore malformed tile geometry
          }
        }
        const builtUp = map
          .querySourceFeatures(VECTOR_SOURCE_ID, {
            sourceLayer: 'landuse',
            filter: ['in', ['get', 'class'], ['literal', ['residential', 'industrial', 'commercial', 'retail']]],
          })
          .some((f) => {
            try {
              return booleanIntersects(shape, f as Feature);
            } catch {
              return false;
            }
          });
        return { buildings, builtUp };
      },
    };
  }, []);

  // MapLibre sets position relative on its container, so the absolute positioning lives on a wrapper
  return (
    <div className="fs-map absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});
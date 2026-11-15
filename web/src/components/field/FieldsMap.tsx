import { useEffect, useRef } from 'react';
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection, Polygon } from 'geojson';
import { COLORS, SATELLITE_SOURCE, WELL_COLORS } from '../../lib/mapConfig';
import type { WaterPointStatus } from '../../lib/waterPoints';

// A small satellite map of the farmer's fields, for the dashboard and the field page
// View only: no drawing. Clicking a field selects it, hovering shows a short label
// The full map (drawing, Cadastre, water points) stays on /map

setWorkerUrl(maplibreWorkerUrl);

export interface MapField {
  id: string;
  geometry: Polygon;
}

interface Props {
  fields: MapField[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
  // Title and lines of the hover label of a field
  describe?: (id: string) => { title: string; lines: string[] } | null;
  // The water point of the selected field, drawn with a dashed line to it
  well?: { lon: number; lat: number; status: WaterPointStatus; from: [number, number] } | null;
  // Accessible name of the map
  label: string;
  className?: string;
}

const STYLE: StyleSpecification = {
  version: 8,
  sources: { sat: SATELLITE_SOURCE },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#1a2325' } },
    { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } },
  ],
};

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function boundsOf(polygons: Polygon[]): LngLatBounds | null {
  const b = new LngLatBounds();
  let any = false;
  for (const p of polygons) {
    for (const [lon, lat] of p.coordinates[0] ?? []) {
      b.extend([lon, lat]);
      any = true;
    }
  }
  return any ? b : null;
}

export function FieldsMap({ fields, selectedId, onSelect, describe, well, label, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  // Latest props for the map's event handlers
  const propsRef = useRef({ fields, selectedId, onSelect, describe, well });
  propsRef.current = { fields, selectedId, onSelect, describe, well };

  const push = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { fields: list, selectedId: sel, well: w } = propsRef.current;
    (map.getSource('fs-fields') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: list.map((f) => ({
        type: 'Feature',
        id: f.id,
        properties: { id: f.id, selected: f.id === sel },
        geometry: f.geometry,
      })),
    });
    (map.getSource('fs-well') as GeoJSONSource | undefined)?.setData(
      w
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: { status: w.status }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } },
              { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [w.from, [w.lon, w.lat]] } },
            ],
          }
        : EMPTY,
    );
  };

  const frame = (animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const { fields: list, selectedId: sel, well: w } = propsRef.current;
    const chosen = list.find((f) => f.id === sel);
    const polygons = chosen ? [chosen.geometry] : list.map((f) => f.geometry);
    const bounds = boundsOf(polygons);
    if (!bounds) return;
    if (chosen && w) bounds.extend([w.lon, w.lat]);
    map.fitBounds(bounds, { padding: 40, maxZoom: chosen ? 17 : 16, duration: animate ? 700 : 0 });
  };

  // Create the map once
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: STYLE,
      center: [23.7, 38.6],
      zoom: 6,
      maxZoom: 18,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    let popup: Popup | null = null;
    let hoveredId: string | null = null;

    map.on('load', () => {
      map.addSource('fs-fields', { type: 'geojson', data: EMPTY, promoteId: 'id' });
      map.addLayer({
        id: 'fs-fields-fill',
        type: 'fill',
        source: 'fs-fields',
        paint: {
          'fill-color': ['case', ['get', 'selected'], COLORS.selected, '#ffffff'],
          'fill-opacity': [
            'case',
            ['get', 'selected'],
            0.42,
            ['boolean', ['feature-state', 'hover'], false],
            0.22,
            0.08,
          ],
        },
      });
      map.addLayer({
        id: 'fs-fields-line',
        type: 'line',
        source: 'fs-fields',
        paint: {
          'line-color': ['case', ['get', 'selected'], COLORS.selected, '#ffffff'],
          'line-width': ['case', ['get', 'selected'], 3, 2],
        },
      });
      map.addSource('fs-well', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'fs-well-link',
        type: 'line',
        source: 'fs-well',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'fs-well-point',
        type: 'circle',
        source: 'fs-well',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['get', 'status'],
            'active',
            WELL_COLORS.active,
            'inactive',
            WELL_COLORS.inactive,
            WELL_COLORS.unknown,
          ],
          'circle-stroke-color': '#1a2325',
          'circle-stroke-width': 2,
        },
      });
      loadedRef.current = true;
      push();
      frame(false);
      // Small map: keep the credit line folded behind its (i) button until it is clicked
      containerRef.current
        ?.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')
        ?.classList.remove('maplibregl-compact-show');
    });

    map.on('mousemove', 'fs-fields-fill', (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (!id) return;
      if (hoveredId !== id) {
        if (hoveredId) map.setFeatureState({ source: 'fs-fields', id: hoveredId }, { hover: false });
        hoveredId = id;
        map.setFeatureState({ source: 'fs-fields', id }, { hover: true });
      }
      map.getCanvas().style.cursor = propsRef.current.onSelect ? 'pointer' : '';
      const info = propsRef.current.describe?.(id);
      if (!info) return;
      const html = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = info.title;
      html.append(title);
      for (const line of info.lines) {
        const p = document.createElement('p');
        p.textContent = line;
        html.append(p);
      }
      if (!popup) {
        popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fs-popup', maxWidth: '240px', offset: 12 });
      }
      popup.setLngLat(e.lngLat).setDOMContent(html).addTo(map);
    });
    map.on('mouseleave', 'fs-fields-fill', () => {
      if (hoveredId) map.setFeatureState({ source: 'fs-fields', id: hoveredId }, { hover: false });
      hoveredId = null;
      map.getCanvas().style.cursor = '';
      popup?.remove();
    });
    map.on('click', 'fs-fields-fill', (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) propsRef.current.onSelect?.(id);
    });

    // Keep the canvas sized to its box (the box changes on layout changes, not only on resize)
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      popup?.remove();
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // New data: redraw - New selection or new set of fields: frame it
  const fieldKey = fields.map((f) => f.id).join(',');
  const wellKey = well ? `${well.lon},${well.lat},${well.status},${well.from.join(',')}` : '';
  useEffect(() => {
    push();
  }, [fields, selectedId, wellKey]);
  useEffect(() => {
    if (loadedRef.current) frame(true);
  }, [selectedId, fieldKey]);

  return (
    <div className={`fs-map relative overflow-hidden ${className ?? ''}`}>
      {/* MapLibre makes its container position: relative, so it is sized with h-full, not inset-0 */}
      <div ref={containerRef} className="h-full w-full" role="region" aria-label={label} />
    </div>
  );
}

export default FieldsMap;
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { Polygon } from 'geojson';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  createField,
  deleteField,
  describeError,
  fieldLimit,
  listMyFields,
  previewField,
  roundPolygon,
  updateFieldDetails,
  updateFieldGeometry,
  type BoundarySource,
  type FieldPreview,
  type FieldRecord,
  type Irrigation,
} from '../lib/fields';
import { fetchParcelAt, fetchParcelByKaek, normaliseKaek, type ParcelHit } from '../lib/cadastre';
import {
  DEPTH_KINDS,
  linkedWaterPoint,
  parseDepth,
  setFieldWaterSource,
  type WaterPoint,
} from '../lib/waterPoints';
import { MIN_DRAW_ZOOM, MIN_WELL_ZOOM } from '../lib/mapConfig';
import { setUnsavedMessage } from '../lib/navigationGuard';
import {
  FieldMapCanvas,
  type Basemap,
  type BuildingCheck,
  type CanvasMode,
  type FieldMapHandle,
  type ParcelStatus,
} from '../components/map/FieldMapCanvas';
import { MapToolbar, type KaekSearchResult } from '../components/map/MapToolbar';
import {
  DrawingPanel,
  FieldDetailPanel,
  FieldListPanel,
  ParcelPanel,
  ShapePanel,
  WellPickPanel,
} from '../components/map/FieldPanels';

type Mode = 'browse' | 'drawing' | 'review' | 'editing';

// Map preferences are remembered per account, so the next person on the same browser
// starts from the defaults (satellite on, Cadastre off). Guests get a new account each time
const basemapKey = (userId: string | null) => `fieldshift.basemap.${userId ?? 'anon'}`;
const parcelsKey = (userId: string | null) => `fieldshift.parcels.${userId ?? 'anon'}`;
const wellsKey = (userId: string | null) => `fieldshift.wells.${userId ?? 'anon'}`;

function readWells(userId: string | null): boolean {
  try {
    return localStorage.getItem(wellsKey(userId)) === '1';
  } catch {
    return false;
  }
}

// Choosing the water source of one field
interface WellPick {
  fieldId: string;
  chosen: WaterPoint | null;
  depth: string;
  depthError: string | null;
  saving: boolean;
  error: string | null;
}
const shapeKey = (p: Polygon) => JSON.stringify(roundPolygon(p).coordinates);

function readParcels(userId: string | null): boolean {
  try {
    return localStorage.getItem(parcelsKey(userId)) === '1';
  } catch {
    return false;
  }
}

interface ParcelPick {
  loading: boolean;
  hit: ParcelHit | null;
  error: string | null;
}

function readBasemap(userId: string | null): Basemap {
  try {
    return localStorage.getItem(basemapKey(userId)) === 'map' ? 'map' : 'satellite';
  } catch {
    return 'satellite';
  }
}

export const FieldMap: React.FC = () => {
  const { user, isAnonymous } = useAuth();
  const userId = user?.id ?? null;
  const { t, language } = useLanguage();
  const [params, setParams] = useSearchParams();
  const mapRef = useRef<FieldMapHandle>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // Data
  const [fields, setFields] = useState<FieldRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Map
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(6);
  const [basemap, setBasemap] = useState<Basemap>(() => readBasemap(userId));
  const [showParcels, setShowParcels] = useState<boolean>(() => readParcels(userId));
  const [parcelStatus, setParcelStatus] = useState<ParcelStatus>('off');
  const [showWells, setShowWells] = useState<boolean>(() => readWells(userId));
  const [wellStatus, setWellStatus] = useState<ParcelStatus>('off');
  const [wellPick, setWellPick] = useState<WellPick | null>(null);
  const [parcelPick, setParcelPick] = useState<ParcelPick | null>(null);
  const parcelSeq = useRef(0);
  // Where the boundary being reviewed came from: a Cadastre parcel, and its shape at that moment
  const originRef = useRef<{ kaek: string | null; key: string } | null>(null);
  const [originKaek, setOriginKaek] = useState<{ kaek: string | null } | null>(null);

  // Workflow
  const [mode, setMode] = useState<Mode>('browse');
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('field'));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [areaSoFar, setAreaSoFar] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  // Shape being drawn or edited
  const [shape, setShape] = useState<Polygon | null>(null);
  const [preview, setPreview] = useState<FieldPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [trimmed, setTrimmed] = useState<{ m2: number; parts: boolean } | null>(null);
  const [buildings, setBuildings] = useState<BuildingCheck | null>(null);
  const [name, setName] = useState('');
  const [irrigation, setIrrigation] = useState<Irrigation>('rainfed');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Field details
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

  const limit = fieldLimit(isAnonymous);
  const selected = useMemo(() => fields.find((f) => f.id === selectedId) ?? null, [fields, selectedId]);
  const canDraw = mapReady && zoom >= MIN_DRAW_ZOOM;
  const pickField = useMemo(
    () => (wellPick ? fields.find((f) => f.id === wellPick.fieldId) ?? null : null),
    [fields, wellPick],
  );
  const canvasMode: CanvasMode =
    mode === 'browse' ? (pickField ? 'pickWell' : 'browse') : mode === 'drawing' ? 'drawing' : 'shape';
  // Water points stay visible while a water source is being chosen, whatever the toggle says
  const wellsVisible = showWells || pickField !== null;

  // Page height: fill the viewport below the app header
  const rootRef = useRef<HTMLDivElement>(null);
  const [offsetTop, setOffsetTop] = useState(64);
  useLayoutEffect(() => {
    const update = () => {
      if (rootRef.current) setOffsetTop(rootRef.current.getBoundingClientRect().top + window.scrollY);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Load fields
  const loadFields = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setFields(await listMyFields());
    } catch (err) {
      setLoadError(describeError(err, tRef.current));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFields();
  }, [loadFields]);

  // First view: the field from the URL, else all fields, else Greece
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current || !mapReady || loading) return;
    framedRef.current = true;
    const fromUrl = fields.find((f) => f.id === selectedId);
    if (fromUrl) mapRef.current?.fitPolygons([fromUrl.geometry]);
    else if (selectedId) setSelectedId(null);
    if (!fromUrl && fields.length > 0) mapRef.current?.fitPolygons(fields.map((f) => f.geometry), 15);
  }, [mapReady, loading, fields, selectedId]);

  // We keep ?field=<id> in the URL in sync, so a selected field can be linked to
  useEffect(() => {
    const current = params.get('field');
    if ((selectedId ?? null) === current) return;
    const next = new URLSearchParams(params);
    if (selectedId) next.set('field', selectedId);
    else next.delete('field');
    setParams(next, { replace: true });
  }, [selectedId, params, setParams]);

  // Warn before leaving with an unsaved boundary (closing the tab, or a link in the header)
  // An empty drawing with no corners yet does not count
  const hasUnsaved =
    mode === 'review' || mode === 'editing' || (mode === 'drawing' && (areaSoFar ?? 0) > 0);

  useEffect(() => {
    if (!hasUnsaved) {
      setUnsavedMessage(null);
      return;
    }
    const message = t('map.unsavedLeave');
    setUnsavedMessage(message);
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      setUnsavedMessage(null);
    };
  }, [hasUnsaved, t]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Another account signed in without leaving the page: switch to its preferences
  const prefsFor = useRef(userId);
  useEffect(() => {
    if (prefsFor.current === userId) return;
    prefsFor.current = userId;
    setShowParcels(readParcels(userId));
    setBasemap(readBasemap(userId));
    setShowWells(readWells(userId));
    setParcelPick(null);
    setWellPick(null);
  }, [userId]);

  const toggleWells = () => {
    setShowWells((on) => {
      const next = !on;
      try {
        localStorage.setItem(wellsKey(userId), next ? '1' : '0');
      } catch {
        // storage unavailable: the choice lasts for this visit only
      }
      return next;
    });
  };

  // Water source of a field
  // Leaving the field (back, another field, deleting it) ends the choice
  useEffect(() => {
    if (wellPick && wellPick.fieldId !== selectedId) setWellPick(null);
  }, [wellPick, selectedId]);

  const startWellPick = () => {
    if (!selected) return;
    setParcelPick(null);
    setWellPick({
      fieldId: selected.id,
      chosen: linkedWaterPoint(selected),
      depth: selected.well_depth_m != null ? String(selected.well_depth_m) : '',
      depthError: null,
      saving: false,
      error: null,
    });
    // Close enough to see the points around the field
    mapRef.current?.fitPolygons([selected.geometry], 15);
  };

  const handleWellClick = (point: WaterPoint) => {
    setWellPick((prev) => (prev && !prev.saving ? { ...prev, chosen: point, depthError: null, error: null } : prev));
  };

  const saveWaterSource = async (remove = false) => {
    if (!wellPick || !pickField) return;
    const chosen = remove ? null : wellPick.chosen;
    if (!remove && !chosen) return;

    let depth: number | null = null;
    if (chosen && DEPTH_KINDS.includes(chosen.kind)) {
      depth = parseDepth(wellPick.depth);
      if (depth !== null && Number.isNaN(depth)) {
        setWellPick({ ...wellPick, depthError: t('map.water.depthInvalid') });
        return;
      }
    }

    setWellPick({ ...wellPick, saving: true, error: null, depthError: null });
    try {
      const row = await setFieldWaterSource(pickField.id, chosen?.id ?? null, depth);
      setFields((prev) => prev.map((f) => (f.id === row.id ? row : f)));
      setWellPick(null);
      showToast(remove ? t('map.water.removed') : t('map.water.saved'));
    } catch (err) {
      setWellPick((prev) => (prev ? { ...prev, saving: false, error: describeError(err, t) } : prev));
    }
  };

  const describeWell = useCallback(
    (point: WaterPoint) => {
      const lines = [`${t(`map.wells.kind.${point.kind}`)} · ${t(`map.wells.status.${point.status}`)}`];
      if (point.ownership) {
        lines.push(t('map.wells.ownershipLine', { value: t(`map.wells.ownership.${point.ownership}`) }));
      }
      const place = [point.community, point.municipality].filter(Boolean).join(', ');
      if (place) lines.push(t('map.wells.placeLine', { value: place }));
      if (point.river_basin) lines.push(t('map.wells.basinLine', { value: point.river_basin }));
      return { title: t('map.wells.code', { code: point.code }), lines };
    },
    [t],
  );

  // Dashed line from the field to its water point: the one being chosen, else the saved one
  const wellLink = useMemo(() => {
    const field = pickField ?? (mode === 'browse' ? selected : null);
    if (!field || field.centroid_lon == null || field.centroid_lat == null) return null;
    const to = pickField ? wellPick?.chosen ?? null : linkedWaterPoint(field);
    return to ? { from: [field.centroid_lon, field.centroid_lat] as [number, number], to } : null;
  }, [pickField, wellPick, selected, mode]);

  const toggleParcels = () => {
    setShowParcels((on) => {
      const next = !on;
      try {
        localStorage.setItem(parcelsKey(userId), next ? '1' : '0');
      } catch {
        // storage unavailable: the choice lasts for this visit only
      }
      if (!next) setParcelPick(null);
      return next;
    });
  };

  const changeBasemap = (b: Basemap) => {
    setBasemap(b);
    try {
      localStorage.setItem(basemapKey(userId), b);
    } catch {
      // storage unavailable: the choice lasts for this visit only
    }
  };

  // Debounced boundary search against the database
  const previewSeq = useRef(0);
  const previewTimer = useRef<number | undefined>(undefined);
  const lastShapeKey = useRef<string | null>(null);

  const resetShapeState = () => {
    window.clearTimeout(previewTimer.current);
    previewSeq.current += 1;
    lastShapeKey.current = null;
    setShape(null);
    setPreview(null);
    setChecking(false);
    setPreviewError(null);
    setTrimmed(null);
    setBuildings(null);
    setSaveError(null);
    setSaving(false);
    originRef.current = null;
    setOriginKaek(null);
  };

  const runPreview = (polygon: Polygon, excludeId: string | null) => {
    window.clearTimeout(previewTimer.current);
    setChecking(true);
    previewTimer.current = window.setTimeout(async () => {
      const seq = ++previewSeq.current;
      try {
        const result = await previewField(polygon, excludeId);
        if (seq !== previewSeq.current) return;
        setPreviewError(null);
        if (result.status === 'trimmed' && result.geometry) {
          // Move the boundary to stop at the neighbouring field, then show the corrected shape
          const corrected = result.geometry;
          lastShapeKey.current = shapeKey(corrected);
          setTrimmed({ m2: result.overlap_m2 ?? 0, parts: (result.parts ?? 1) > 1 });
          setShape(corrected);
          mapRef.current?.replaceShape(corrected);
          setPreview({ ...result, status: 'ok' });
          setBuildings(mapRef.current?.checkBuildings(corrected) ?? null);
        } else {
          setPreview(result);
          setBuildings(result.status === 'invalid' ? null : mapRef.current?.checkBuildings(polygon) ?? null);
        }
      } catch (err) {
        if (seq !== previewSeq.current) return;
        setPreview(null);
        setPreviewError(describeError(err, tRef.current));
      } finally {
        if (seq === previewSeq.current) setChecking(false);
      }
    }, 400);
  };

  // Map callbacks
  const nextDefaultName = () => {
    const taken = new Set(fields.map((f) => f.name.toLowerCase()));
    let n = fields.length + 1;
    let candidate = t('map.review.defaultName', { n: String(n) });
    while (taken.has(candidate.toLowerCase())) {
      n += 1;
      candidate = t('map.review.defaultName', { n: String(n) });
    }
    return candidate;
  };

  const handleDrawComplete = (polygon: Polygon) => {
    resetShapeState();
    lastShapeKey.current = shapeKey(polygon);
    setShape(polygon);
    setName(nextDefaultName());
    setIrrigation('rainfed');
    setAreaSoFar(null);
    setMode('review');
    runPreview(polygon, null);
  };

  const handleShapeChange = (polygon: Polygon) => {
    if (modeRef.current !== 'review' && modeRef.current !== 'editing') return;
    const key = shapeKey(polygon);
    if (key === lastShapeKey.current) return; // our own update, or nothing actually moved
    lastShapeKey.current = key;
    setTrimmed(null);
    setSaveError(null);
    setShape(polygon);
    runPreview(polygon, editingIdRef.current);
  };

  const handleFieldClick = (id: string) => {
    setParcelPick(null);
    setSelectedId(id);
    setDetailError(null);
  };

  const handleParcelClick = async (lng: number, lat: number) => {
    const seq = ++parcelSeq.current;
    setSelectedId(null);
    setParcelPick({ loading: true, hit: null, error: null });
    try {
      const hit = await fetchParcelAt(lng, lat);
      if (seq !== parcelSeq.current) return;
      setParcelPick({ loading: false, hit, error: null });
    } catch {
      if (seq !== parcelSeq.current) return;
      setParcelPick({ loading: false, hit: null, error: tRef.current('map.cadastre.loadFailed') });
    }
  };

  const searchKaek = async (input: string): Promise<KaekSearchResult> => {
    if (!normaliseKaek(input)) return 'invalid';
    const seq = ++parcelSeq.current;
    try {
      const hit = await fetchParcelByKaek(input);
      if (seq !== parcelSeq.current) return 'found'; // a newer click or search took over
      if (!hit) return 'notFound';
      // Same result as clicking the parcel: show it, outline it and offer "Use as my field"
      if (mode === 'browse') {
        setSelectedId(null);
        setParcelPick({ loading: false, hit, error: null });
      }
      mapRef.current?.fitPolygons([hit.polygon]);
      return 'found';
    } catch {
      return 'error';
    }
  };

  const applyParcel = () => {
    const hit = parcelPick?.hit;
    if (!hit || hit.hasHoles || fields.length >= limit) return;
    resetShapeState();
    setParcelPick(null);
    const polygon = hit.polygon;
    lastShapeKey.current = shapeKey(polygon);
    originRef.current = { kaek: hit.kaek, key: lastShapeKey.current };
    setOriginKaek({ kaek: hit.kaek });
    setShape(polygon);
    setName(nextDefaultName());
    setIrrigation('rainfed');
    setAreaSoFar(null);
    setMode('review');
    mapRef.current?.loadShape(polygon);
    mapRef.current?.fitPolygons([polygon]);
    runPreview(polygon, null);
  };

  // Actions
  const startAdd = () => {
    if (!canDraw || fields.length >= limit) return;
    resetShapeState();
    setSelectedId(null);
    setParcelPick(null);
    setAreaSoFar(null);
    setCanUndo(false);
    setMode('drawing');
    mapRef.current?.startDrawing();
  };

  const cancelDrawing = () => {
    mapRef.current?.cancelDrawing();
    setAreaSoFar(null);
    setCanUndo(false);
    setMode('browse');
  };

  const redraw = () => {
    resetShapeState();
    setAreaSoFar(null);
    setCanUndo(false);
    setMode('drawing');
    mapRef.current?.startDrawing();
  };

  const discardShape = () => {
    mapRef.current?.clearShape();
    resetShapeState();
    setEditingId(null);
    setMode('browse');
  };

  const startEditBoundary = () => {
    if (!selected) return;
    resetShapeState();
    setDetailError(null);
    setEditingId(selected.id);
    setMode('editing');
    lastShapeKey.current = shapeKey(selected.geometry);
    setShape(selected.geometry);
    mapRef.current?.loadShape(selected.geometry);
    mapRef.current?.fitPolygons([selected.geometry]);
    runPreview(selected.geometry, selected.id);
  };

  const saveShape = async () => {
    if (!shape || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (mode === 'review') {
        const origin = originRef.current;
        const source: BoundarySource = !origin
          ? 'drawn'
          : shapeKey(shape) === origin.key
            ? 'cadastre'
            : 'cadastre_edited';
        const row = await createField(name.trim(), shape, irrigation, source, origin?.kaek ?? null);
        setFields((prev) => [...prev, row]);
        mapRef.current?.clearShape();
        resetShapeState();
        setMode('browse');
        setSelectedId(row.id);
        showToast(t('map.review.saved', { name: row.name }));
      } else if (mode === 'editing' && editingId) {
        const row = await updateFieldGeometry(editingId, shape);
        setFields((prev) => prev.map((f) => (f.id === row.id ? row : f)));
        mapRef.current?.clearShape();
        resetShapeState();
        setEditingId(null);
        setMode('browse');
        showToast(t('map.review.updated'));
      }
    } catch (err) {
      setSaveError(describeError(err, t));
      setSaving(false);
    }
  };

  // Opened from the field page with ?field=<id>&action=edit|water: start that tool right away
  // on the field, once the map and the fields are ready. The action is used once, then dropped
  const actionRef = useRef(params.get('action'));
  useEffect(() => {
    const action = actionRef.current;
    if (!action || !mapReady || loading) return;
    actionRef.current = null;
    const next = new URLSearchParams(params);
    next.delete('action');
    setParams(next, { replace: true });
    if (!selected || mode !== 'browse') return;
    if (action === 'edit') startEditBoundary();
    else if (action === 'water') startWellPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, loading, selected]);

  const selectFromList = (id: string) => {
    const field = fields.find((f) => f.id === id);
    setParcelPick(null);
    setSelectedId(id);
    setDetailError(null);
    if (field) mapRef.current?.fitPolygons([field.geometry]);
  };

  const patchSelected = async (patch: Partial<Pick<FieldRecord, 'name' | 'irrigation'>>, message: string) => {
    if (!selected) return false;
    setDetailBusy(true);
    setDetailError(null);
    try {
      await updateFieldDetails(selected.id, patch);
      setFields((prev) =>
        prev.map((f) => (f.id === selected.id ? { ...f, ...patch, updated_at: new Date().toISOString() } : f)),
      );
      showToast(message);
      return true;
    } catch (err) {
      setDetailError(describeError(err, t));
      return false;
    } finally {
      setDetailBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!selected) return;
    if (!window.confirm(t('profile.confirmDeleteField', { name: selected.name }))) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      await deleteField(selected.id);
      setFields((prev) => prev.filter((f) => f.id !== selected.id));
      setSelectedId(null);
      showToast(t('map.detail.deleted', { name: selected.name }));
    } catch (err) {
      setDetailError(describeError(err, t));
    } finally {
      setDetailBusy(false);
    }
  };

  // Render
  let panel: React.ReactNode;
  if (mode === 'drawing') {
    panel = (
      <DrawingPanel
        areaSoFar={areaSoFar}
        canUndo={canUndo}
        onUndo={() => mapRef.current?.undo()}
        onCancel={cancelDrawing}
      />
    );
  } else if (mode === 'review' || mode === 'editing') {
    panel = (
      <ShapePanel
        isNew={mode === 'review'}
        preview={preview}
        checking={checking}
        previewError={previewError}
        trimmedM2={trimmed ? trimmed.m2 : null}
        trimmedParts={trimmed?.parts ?? false}
        buildings={buildings}
        name={name}
        onNameChange={setName}
        irrigation={irrigation}
        onIrrigationChange={setIrrigation}
        saving={saving}
        saveError={saveError}
        onSave={() => void saveShape()}
        onRedraw={redraw}
        onDiscard={discardShape}
        fromCadastre={mode === 'review' && originKaek !== null}
        cadastreKaek={originKaek?.kaek ?? null}
      />
    );
  } else if (wellPick && pickField) {
    panel = (
      <WellPickPanel
        field={pickField}
        chosen={wellPick.chosen}
        depth={wellPick.depth}
        onDepthChange={(v) => setWellPick({ ...wellPick, depth: v, depthError: null })}
        depthError={wellPick.depthError}
        zoomedOut={zoom < MIN_WELL_ZOOM}
        saving={wellPick.saving}
        error={wellPick.error}
        onSave={() => void saveWaterSource()}
        onRemove={() => void saveWaterSource(true)}
        onCancel={() => setWellPick(null)}
      />
    );
  } else if (parcelPick) {
    panel = (
      <ParcelPanel
        loading={parcelPick.loading}
        hit={parcelPick.hit}
        error={parcelPick.error}
        atLimit={fields.length >= limit}
        limit={limit}
        onUse={applyParcel}
        onClose={() => setParcelPick(null)}
      />
    );
  } else if (selected) {
    panel = (
      <FieldDetailPanel
        field={selected}
        busy={detailBusy}
        error={detailError}
        onBack={() => setSelectedId(null)}
        onRename={(newName) => patchSelected({ name: newName }, t('map.detail.renamed'))}
        onIrrigation={(v) => void patchSelected({ irrigation: v }, t('map.detail.irrigationSaved'))}
        onEditBoundary={startEditBoundary}
        onDelete={() => void removeSelected()}
        onChooseWater={startWellPick}
      />
    );
  } else {
    panel = (
      <FieldListPanel
        fields={fields}
        loading={loading}
        loadError={loadError}
        onRetry={() => void loadFields()}
        limit={limit}
        isAnonymous={isAnonymous}
        canDraw={canDraw}
        onAdd={startAdd}
        onZoomIn={() => mapRef.current?.zoomInForDrawing()}
        onSelect={selectFromList}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className="cf-map-page flex flex-col lg:flex-row w-full overflow-hidden bg-cf-bg text-cf-text font-sans"
      style={{ height: `calc(100dvh - ${offsetTop}px)`, minHeight: 480 }}
    >
      <aside className="cf-map-aside order-2 lg:order-1 shrink-0 lg:w-[380px] max-h-[46%] lg:max-h-none overflow-y-auto bg-cf-bg border-t lg:border-t-0 lg:border-r border-cf-primary/15 p-5 sm:p-6">
        {panel}
      </aside>

      <div className="order-1 lg:order-2 relative flex-1 min-h-0 bg-ground-deep">
        <FieldMapCanvas
          ref={mapRef}
          fields={fields}
          selectedId={selectedId}
          editingId={editingId}
          mode={canvasMode}
          basemap={basemap}
          language={language}
          neighbourTitle={t('map.neighbour.title')}
          neighbourDesc={t('map.neighbour.desc')}
          outsideMessage={t('map.outside')}
          showParcels={showParcels}
          highlightParcel={mode === 'browse' ? parcelPick?.hit?.polygon ?? null : null}
          onParcelClick={(lng, lat) => void handleParcelClick(lng, lat)}
          onParcelStatus={setParcelStatus}
          showWells={wellsVisible}
          wellLink={wellLink}
          onWellClick={handleWellClick}
          onWellStatus={setWellStatus}
          describeWell={describeWell}
          onFieldClick={handleFieldClick}
          onDrawProgress={setAreaSoFar}
          onDrawComplete={handleDrawComplete}
          onShapeChange={handleShapeChange}
          onBlockedPoint={() => showToast(t('map.review.blockedPoint'))}
          onOutsidePoint={() => showToast(t('map.outside'))}
          onZoomChange={setZoom}
          onCanUndoChange={setCanUndo}
          onReady={() => setMapReady(true)}
        />

        <MapToolbar
          basemap={basemap}
          onBasemapChange={changeBasemap}
          onGoTo={(bounds, maxZoom) => mapRef.current?.fitBounds(bounds, maxZoom)}
          showParcels={showParcels}
          onToggleParcels={toggleParcels}
          parcelStatus={parcelStatus}
          onKaekSearch={searchKaek}
          showWells={wellsVisible}
          onToggleWells={toggleWells}
          wellStatus={wellStatus}
          wellsLocked={pickField !== null}
        />

        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="fs-map-panel rounded-full p-3">
              <Loader2 className="w-6 h-6 text-cf-text animate-spin" aria-label={t('common.loading')} />
            </span>
          </div>
        )}

        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 w-max max-w-[calc(100%-2rem)] pointer-events-none"
        >
          {toast && (
            <div className="fs-map-panel fs-toast rounded-xl px-4 py-2.5 text-sm text-cf-text">{toast}</div>
          )}
        </div>
      </div>
    </div>
  );
};
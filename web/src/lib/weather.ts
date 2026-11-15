// Weather forecast for a field, from Open-Meteo (https://open-meteo.com).
// Free, no API key, called straight from the browser with the field's centre (my_fields.centroid_*),
// so no backend is needed. Data: CC BY 4.0, credit shown under the forecast. The free API is for
// non-commercial use (fewer than 10,000 calls a day); answers are kept for 30 minutes per place

export const WEATHER_SOURCE_URL = 'https://open-meteo.com/';
const API = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MINUTES = 30;
export const FORECAST_DAYS = 7;

export interface WeatherDay {
  date: string; // YYYY-MM-DD, local time of the place
  code: number; // WMO weather code
  tMax: number | null;
  tMin: number | null;
  rainMm: number | null;
  rainChance: number | null; // %
  windMax: number | null; // km/h
  gustMax: number | null; // km/h
  et0Mm: number | null; // reference evapotranspiration (FAO-56), mm
}

export interface WeatherNow {
  time: string;
  code: number;
  temp: number | null;
  feelsLike: number | null;
  humidity: number | null; // %
  wind: number | null; // km/h
  rainMm: number | null;
}

export interface Forecast {
  elevation: number | null;
  now: WeatherNow;
  days: WeatherDay[];
  fetchedAt: number;
}

const DAILY = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'et0_fao_evapotranspiration',
];
const CURRENT = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'precipitation'];

// About 1 km: fields that close share one answer
const cacheKey = (lat: number, lon: number) => `fieldshift.weather.${lat.toFixed(2)},${lon.toFixed(2)}`;

function readCache(key: string): Forecast | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Forecast;
    return Date.now() - value.fetchedAt < CACHE_MINUTES * 60_000 ? value : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: Forecast) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the forecast still shows, it is just fetched again next time
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function fetchForecast(lat: number, lon: number, signal?: AbortSignal): Promise<Forecast> {
  const key = cacheKey(lat, lon);
  const cached = readCache(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: DAILY.join(','),
    current: CURRENT.join(','),
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
  });
  const res = await fetch(`${API}?${params}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  const d = data.daily ?? {};
  const c = data.current ?? {};
  const days: WeatherDay[] = (d.time ?? []).map((date: string, i: number) => ({
    date,
    code: num(d.weather_code?.[i]) ?? 0,
    tMax: num(d.temperature_2m_max?.[i]),
    tMin: num(d.temperature_2m_min?.[i]),
    rainMm: num(d.precipitation_sum?.[i]),
    rainChance: num(d.precipitation_probability_max?.[i]),
    windMax: num(d.wind_speed_10m_max?.[i]),
    gustMax: num(d.wind_gusts_10m_max?.[i]),
    et0Mm: num(d.et0_fao_evapotranspiration?.[i]),
  }));
  const forecast: Forecast = {
    elevation: num(data.elevation),
    now: {
      time: String(c.time ?? ''),
      code: num(c.weather_code) ?? 0,
      temp: num(c.temperature_2m),
      feelsLike: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      wind: num(c.wind_speed_10m),
      rainMm: num(c.precipitation),
    },
    days,
    fetchedAt: Date.now(),
  };
  writeCache(key, forecast);
  return forecast;
}

// WMO weather codes, grouped into the kinds we show (one icon and one label each)
export type Sky =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'freezingRain'
  | 'snow'
  | 'showers'
  | 'thunder'
  | 'hail';

export function skyOf(code: number): Sky {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code === 56 || code === 57 || code === 66 || code === 67) return 'freezingRain';
  if (code >= 61 && code <= 65) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code === 95) return 'thunder';
  if (code === 96 || code === 99) return 'hail';
  return 'cloudy';
}

// What a farmer should watch for in the coming days
export const FROST_C = 0; // night minimum at or below: frost risk
export const HEAT_C = 38; // day maximum at or above: heat stress
export const HEAVY_RAIN_MM = 20; // daily total at or above: heavy rain, no field work
export const STRONG_GUST_KMH = 50; // gusts at or above: no spraying, sprinklers drift

export type AlertKind = 'frost' | 'heat' | 'heavyRain' | 'wind';

export interface WeatherAlert {
  kind: AlertKind;
  // Days it applies to, in order
  dates: string[];
}

export function alertsFor(days: WeatherDay[]): WeatherAlert[] {
  const pick = (test: (d: WeatherDay) => boolean) => days.filter(test).map((d) => d.date);
  const alerts: WeatherAlert[] = [
    { kind: 'frost', dates: pick((d) => d.tMin !== null && d.tMin <= FROST_C) },
    { kind: 'heat', dates: pick((d) => d.tMax !== null && d.tMax >= HEAT_C) },
    { kind: 'heavyRain', dates: pick((d) => d.rainMm !== null && d.rainMm >= HEAVY_RAIN_MM) },
    { kind: 'wind', dates: pick((d) => d.gustMax !== null && d.gustMax >= STRONG_GUST_KMH) },
  ];
  return alerts.filter((a) => a.dates.length > 0);
}

// Water balance of the coming days: rain against reference evapotranspiration (crop water demand)
export function waterBalance(days: WeatherDay[]): { rain: number; et0: number } {
  return days.reduce(
    (acc, d) => ({ rain: acc.rain + (d.rainMm ?? 0), et0: acc.et0 + (d.et0Mm ?? 0) }),
    { rain: 0, et0: 0 },
  );
}
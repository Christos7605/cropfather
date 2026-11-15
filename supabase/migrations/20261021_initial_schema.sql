-- Enable PostGIS extension for spatial queries
create extension if not exists postgis;

-- Farmer profiles (tied to Supabase Auth)
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  language text default 'el',
  created_at timestamptz default now()
);

-- Farmer fields (Spatial Polygon data)
create table public.fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  geom geometry(Polygon, 4326) not null,
  area_ha numeric,
  irrigation text check (irrigation in ('rainfed','limited','full')) default 'rainfed',
  cell_id int,
  created_at timestamptz default now()
);
create index fields_geom_idx on public.fields using gist (geom);
create index fields_user_id_idx on public.fields(user_id);

-- Crop history provided by the farmer
create table public.crop_history (
  id bigint generated always as identity primary key,
  field_id uuid not null references public.fields on delete cascade,
  season_year int not null,
  crop_id text not null,
  source text default 'farmer'
);
create index crop_history_field_id_idx on public.crop_history(field_id);

-- Reference data: Crops metadata (public read)
create table public.crops (
  id text primary key, 
  name_en text, 
  name_el text,
  family text, 
  type text, 
  n_fixer boolean default false
);

-- Reference data: Crop technical parameters for water balance & stress
create table public.crop_params (
  crop_id text primary key references public.crops,
  tbase numeric, 
  t_heat_stress numeric, 
  t_kill numeric,
  kc_ini numeric, 
  kc_mid numeric, 
  kc_end numeric,
  stage_days jsonb, 
  root_depth_m numeric,
  residue_index numeric, 
  sowing_window jsonb, 
  source text
);

-- Precomputed environment grid cells (for NASA climate & soil data)
create table public.grid_cells (
  id serial primary key,
  geom geometry(Polygon, 4326) not null,
  centroid geometry(Point, 4326) not null,
  elevation_m numeric
);
create index grid_cells_geom_idx on public.grid_cells using gist (geom);

-- Cell summaries (stores precomputed climate baselines / deltas)
create table public.cell_summaries (
  cell_id int references public.grid_cells on delete cascade,
  kind text, -- e.g., 'baseline' | 'delta_ssp245' | 'soil'
  data jsonb not null,
  primary key (cell_id, kind)
);

-- Saved recommendation runs
create table public.recommendation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  field_id uuid references public.fields on delete cascade,
  scenario text, 
  weights jsonb, 
  results jsonb,
  model_version text, 
  created_at timestamptz default now()
);
create index recommendation_runs_user_id_idx on public.recommendation_runs(user_id);

-- Enable Row Level Security (RLS) & Policies
alter table public.fields enable row level security;
create policy "Users can manage their own fields" 
  on public.fields for all 
  using (auth.uid() = user_id) 
  with check (auth.uid() = user_id);

alter table public.recommendation_runs enable row level security;
create policy "Users can manage their own recommendation runs" 
  on public.recommendation_runs for all 
  using (auth.uid() = user_id) 
  with check (auth.uid() = user_id);
-- 20261043_model_data.sql
-- Field Shift: one row per field for the prediction model.
--
--   model_data (view)   appears with the field and disappears with it.
--                       farm_questionnaire   the owner's general questionnaire (latest version)
--                       field_questionnaire  this field's questionnaire (latest version)
--                       seasons              crop, dates, costs and income for each season
--                       coords               boundary in the satellite-request shape
--
-- The answers are already stored as JSON on farmer_questionnaire_responses and
-- questionnaire_responses. This view only reads them. Drafts are included.
--
-- coords.start stays 2023-07-01. coords.end is the day the farmer pressed
-- Predict for this field, or 2023-07-31 until they have. coords.max_cloud
-- is always 15. The ring is the outer boundary, [lon, lat], without the
-- repeated closing point.
--
-- Run after 20261042_policy_read.sql. Idempotent.

begin;

alter table public.fields
  add column if not exists prediction_requested_on date;

comment on column public.fields.prediction_requested_on is
  'Calendar day the farmer last pressed Predict for this field. model_data.coords.end uses it.';

create or replace view public.model_data
with (security_invoker = true) as
select
  f.id      as field_id,
  f.user_id,
  (
    select jsonb_build_object(
      'version',        r.version,
      'status',         r.status,
      'answered_count', r.answered_count,
      'question_count', r.question_count,
      'answers',        r.answers,
      'updated_at',     r.updated_at,
      'submitted_at',   r.submitted_at
    )
    from public.farmer_questionnaire_responses r
    where r.user_id = f.user_id
    order by r.updated_at desc
    limit 1
  ) as farm_questionnaire,
  (
    select jsonb_build_object(
      'version',        r.version,
      'status',         r.status,
      'answered_count', r.answered_count,
      'question_count', r.question_count,
      'answers',        r.answers,
      'updated_at',     r.updated_at,
      'submitted_at',   r.submitted_at
    )
    from public.questionnaire_responses r
    where r.field_id = f.id
    order by r.updated_at desc
    limit 1
  ) as field_questionnaire,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'season_id',     sf.season_id,
        'crop_id',       sf.crop_id,
        'crop_name_en',  sf.crop_name_en,
        'crop_name_el',  sf.crop_name_el,
        'season_year',   sf.season_year,
        'sown_on',       sf.sown_on,
        'harvested_on',  sf.harvested_on,
        'ongoing',       sf.ongoing,
        'tillage',       h.tillage,
        'residues',      h.residues,
        'nitrogen',      h.nitrogen,
        'irrigation',    sf.irrigation_level,
        'yield_outcome', sf.yield_outcome,
        'costs', jsonb_build_object(
          'fertilizer_eur_ha',      sf.fertilizer_eur_ha,
          'crop_protection_eur_ha', sf.crop_protection_eur_ha,
          'seed_eur_ha',            sf.seed_eur_ha,
          'contract_work_eur_ha',   sf.contract_work_eur_ha,
          'irrigation_eur_ha',      sf.irrigation_eur_ha,
          'total_eur_ha',           sf.total_cost_eur_ha,
          'complete',               sf.cost_complete,
          'estimated',              sf.cost_estimated
        ),
        'income', jsonb_build_object(
          'disclosed',        sf.income_disclosed,
          'yield_kg_ha',      sf.reported_main_kg_ha,
          'price_eur_kg',     sf.reported_main_price_eur_kg,
          'straw_kg_ha',      sf.straw_kg_ha,
          'straw_price_eur_kg', sf.straw_price_eur_kg,
          'subsidy_eur_ha',   sf.subsidy_eur_ha,
          'other_eur_ha',     sf.other_income_eur_ha,
          'revenue_eur_ha',   sf.revenue_eur_ha,
          'revenue_basis',    sf.revenue_basis,
          'margin_eur_ha',    sf.margin_eur_ha
        )
      )
      order by sf.sown_on nulls last, sf.season_id
    )
    from public.season_finance sf
    join public.crop_history h on h.id = sf.season_id
    where sf.field_id = f.id
  ), '[]'::jsonb) as seasons,
  jsonb_build_object(
    'features', jsonb_build_array(jsonb_build_object(
      'coords', coalesce((
        select jsonb_agg(
          jsonb_build_array(
            round(st_x(pt.geom)::numeric, 7),
            round(st_y(pt.geom)::numeric, 7)
          )
          order by pt.path[1]
        )
        from st_dumppoints(st_exteriorring(f.geom)) as pt
        where pt.path[1] < st_npoints(st_exteriorring(f.geom))
      ), '[]'::jsonb)
    )),
    'start', '2023-07-01',
    'end', coalesce(to_char(f.prediction_requested_on, 'YYYY-MM-DD'), '2023-07-31'),
    'max_cloud', 15
  ) as coords
from public.fields f;

revoke all on public.model_data from public, anon;
grant select on public.model_data to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually, as the field's owner or the service role):
--   select field_id,
--          farm_questionnaire ->> 'status' as farm_status,
--          field_questionnaire ->> 'status' as field_status,
--          jsonb_array_length(seasons) as seasons,
--          coords ->> 'max_cloud' as max_cloud,
--          jsonb_array_length(coords -> 'features' -> 0 -> 'coords') as corners
--   from public.model_data;
-- ---------------------------------------------------------------------------

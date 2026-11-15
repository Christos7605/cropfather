-- New accounts (including guests) start in the language the visitor was already using.
-- The frontend passes it as user metadata ({ language: 'el' | 'en' }) on sign-up and
-- anonymous sign-in. Anything else falls back to Greek. Existing profiles are untouched.
-- Idempotent: safe to run more than once.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_language text;
begin
  v_language := new.raw_user_meta_data ->> 'language';
  if v_language is null or v_language not in ('el', 'en') then
    v_language := 'el';
  end if;

  insert into public.profiles (id, display_name, language)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      case when new.is_anonymous then 'Guest Judge' else 'Farmer' end
    ),
    v_language
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
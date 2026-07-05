-- CareCall Portal — campaign scheduling via pg_cron (§2.5, §4.4)
--
-- Runs every 15 minutes all day. `start-campaign` itself enforces the
-- clinic's calling-hours window (clinic_within_calling_hours), so this
-- schedule is safe to run outside business hours: off-hours invocations
-- exit quietly.
--
-- Requires the pg_cron and pg_net extensions (available on Supabase).
-- Set the two settings below to your project before this will fire:
--   select set_config('app.settings.functions_url',
--     'https://<PROJECT_REF>.supabase.co/functions/v1', false);
--   select set_config('app.settings.service_role_key', '<SERVICE_ROLE_KEY>', false);
-- On Supabase, prefer storing these via `alter database ... set` or Vault.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Kicks every active campaign whose clinic is inside its calling window.
create or replace function tick_active_campaigns()
returns void
language plpgsql
security definer as $$
declare
  r record;
  v_url text := current_setting('app.settings.functions_url', true);
  v_key text := current_setting('app.settings.service_role_key', true);
begin
  if v_url is null or v_key is null then
    raise notice 'tick_active_campaigns: functions_url/service_role_key not configured; skipping';
    return;
  end if;

  for r in
    select c.id
    from campaigns c
    where c.status = 'active'
      and (c.scheduled_start is null or c.scheduled_start <= now())
      and clinic_within_calling_hours(c.clinic_id)
  loop
    perform net.http_post(
      url     := v_url || '/start-campaign',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := jsonb_build_object('campaign_id', r.id, 'batch_size', 5)
    );
  end loop;
end $$;

-- (Re)schedule the job.
do $$ begin
  perform cron.unschedule('carecall_tick');
exception when others then null; end $$;

select cron.schedule('carecall_tick', '*/15 * * * *', $$select tick_active_campaigns();$$);

-- CareCall Portal — campaign scheduling via pg_cron (§2.5, §4.4)
--
-- Runs every MINUTE all day in SWEEP mode. `start-campaign` (merged pre-call
-- SMS version) advances every active campaign itself and enforces the clinic's
-- calling-hours window (clinic_within_calling_hours) plus DNC / SMS-consent
-- filters, so a 1-minute all-day schedule is safe: off-hours ticks exit quietly.
--
-- Why every minute (not 15): the pre-call SMS lead time is ~120s. A 1-minute
-- tick makes the actual lead ≈ 2–3 min, which the SMS copy ("about") allows.
--
-- Secrets come from Supabase Vault (hosted Supabase forbids `alter database
-- ... set` / set_config for custom params). Create them once:
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1', 'functions_url');
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');
-- Update later with vault.update_secret(id, new_value).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Sweep: one call advances ALL active campaigns. start-campaign resolves the
-- queue, calling hours, DNC/consent, and the pre-call SMS two-phase queue.
create or replace function tick_active_campaigns()
returns void
language plpgsql
security definer as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key';

  if v_url is null or v_key is null then
    raise notice 'tick_active_campaigns: vault secrets functions_url/service_role_key not set; skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/start-campaign',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := jsonb_build_object('sweep', true, 'batch_size', 5)
  );
end $$;

-- (Re)schedule the job. Reuses the same name so re-runs replace, never duplicate.
do $$ begin
  perform cron.unschedule('carecall_tick');
exception when others then null; end $$;

select cron.schedule('carecall_tick', '* * * * *', $$select tick_active_campaigns();$$);

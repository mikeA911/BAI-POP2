-- CareCall — teardown for mock_data.sql.
-- Removes ONLY the mock rows (fixed UUID prefixes / mock-ccid-* markers);
-- real data created through the portal is untouched. Re-runnable: deleting
-- nothing is fine. Order matters — children before parents (FK constraints).

begin;

-- 1. Call logs (reference appointments, patients, campaigns)
delete from call_logs
where call_control_id like 'mock-ccid-%';

-- 2. Appointments (reference patients, providers, campaigns)
delete from appointments
where idempotency_key like 'mock-appt-%';

-- 3. Campaign membership rows for mock campaigns or mock patients
delete from campaign_patients
where campaign_id in (
        'c0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000002',
        'c0000000-0000-0000-0000-000000000003')
   or patient_id::text like 'a0000000-0000-0000-0000-%';

-- 4. Campaigns
delete from campaigns
where id in (
  'c0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000003');

-- 5. Patients (safety net: refuse to delete any mock patient that somehow
--    acquired a REAL appointment or call log after seeding)
delete from patients p
where p.id::text like 'a0000000-0000-0000-0000-%'
  and not exists (select 1 from appointments a where a.patient_id = p.id)
  and not exists (select 1 from call_logs c where c.patient_id = p.id);

-- 6. Dr. Patel's availability, then Dr. Patel (added by mock_data.sql).
--    Dr. Jones (1111...) stays — that row belongs to the base seed migration.
--    Same safety net: keep the provider if real appointments exist.
delete from provider_availability
where provider_id = '22222222-2222-2222-2222-222222222222';

delete from providers p
where p.id = '22222222-2222-2222-2222-222222222222'
  and not exists (select 1 from appointments a where a.provider_id = p.id)
  and not exists (select 1 from patients pt where pt.provider_id = p.id);

commit;

-- Verify (all should return 0):
-- select count(*) from call_logs where call_control_id like 'mock-ccid-%';
-- select count(*) from patients where id::text like 'a0000000-0000-0000-0000-%';
-- select count(*) from campaigns where id::text like 'c0000000-0000-0000-0000-%';

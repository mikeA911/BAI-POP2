-- ============================================================
-- Single-clinic build: let every authenticated user read the clinic.
--
-- Previously `clinics_read` only returned a row for Admin, or for a
-- non-admin whose JWT `app_metadata.clinic_id` matched. When a Provider/
-- Staff account had no `clinic_id` claim, the clinics query returned no
-- rows, so the dashboard heading fell back to the literal "Dashboard".
--
-- For now there is a single clinic and all users belong to it, so any
-- authenticated user may read the clinics list. This makes the dashboard
-- heading resolve to the clinic name for Admin, Provider and Staff alike.
--
-- When MULTI_CLINIC is enabled, restore clinic-scoped reads:
--   using ( is_admin() or id = jwt_clinic_id() );
-- ============================================================

drop policy if exists clinics_read on clinics;
create policy clinics_read on clinics for select to authenticated
  using ( true );

-- Writes remain Admin-only (unchanged).

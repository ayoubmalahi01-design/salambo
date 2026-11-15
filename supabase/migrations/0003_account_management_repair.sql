-- ============================================================================
-- THE TRAINERS / TADARRAB — 0003 account-management repair
--
-- RUN THIS FILE AFTER:
--   1. supabase/THE_TRAINERS_SETUP.sql
--   2. supabase/INVITATIONS_OTP_INCREMENTAL.sql
--
-- WHY THIS FILE EXISTS
--   The first two files describe a working baseline, but an existing project
--   may still carry the old account rules:
--     * a non-owner active account could not be rejected/kept without an
--       institution, so orphan accounts were stuck in approval;
--     * Administration could invite/approve and the privilege guard allowed
--       manager/admin-style edits;
--     * owner-invited managers were activated automatically by the Edge
--       Function;
--     * OTP acceptance activated a new account without a human review;
--     * there was no safe way to create a profile for an Auth user whose
--       trigger-created profile was missing;
--     * the owner could only see institution audit rows.
--
-- SAFETY
--   * No `DROP TABLE`, no `TRUNCATE`, no business-row deletion.
--   * Every operation is additive / `CREATE OR REPLACE` / a policy replacement.
--   * Constraints are added `NOT VALID` first so legacy rows cannot block the
--     migration. They are validated automatically when the data already agrees.
--   * The file is safe to run more than once.
--   * `ensure_my_profile` and `review_account` are the only trusted repair
--     paths and both re-check the caller's role, institution and target.
--   * This file has NOT been executed against a live Supabase project by the
--     repair process. Run it in staging first and keep a database backup.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.institutions') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.invitations') is null
     or to_regclass('public.otp_codes') is null then
    raise exception
      'Run THE_TRAINERS_SETUP.sql and INVITATIONS_OTP_INCREMENTAL.sql before 0003_account_management_repair.sql';
  end if;

  if to_regprocedure('public.write_audit_log()') is null
     or to_regprocedure('public.guard_profile_privileges()') is null
     or to_regprocedure('public.is_platform_owner()') is null
     or to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.current_institution_id()') is null then
    raise exception 'The base account functions are missing; run THE_TRAINERS_SETUP.sql first';
  end if;

  if to_regprocedure('public.verify_otp_code(uuid, text, uuid)') is null then
    raise exception 'verify_otp_code is missing; run INVITATIONS_OTP_INCREMENTAL.sql first';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Profiles constraint: a rejected/pending orphan is legal; an active
--    non-owner account still requires an institution.
-- ---------------------------------------------------------------------------
do $constraint_repair$
declare
  r record;
begin
  -- The old constraint is unnamed in some projects and named differently in
  -- others. Drop only table checks that mention both institution_id and
  -- account_status, so unrelated checks are preserved.
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.profiles'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%institution_id%'
       and pg_get_constraintdef(c.oid) ilike '%account_status%'
  loop
    execute format('alter table public.profiles drop constraint if exists %I', r.conname);
  end loop;

  alter table public.profiles
    add constraint profiles_role_institution_check check (
      (role = 'owner' and institution_id is null)
      or (role <> 'owner' and institution_id is not null)
      or (institution_id is null and account_status in ('pending', 'rejected'))
    ) not valid;

  if not exists (
    select 1
      from public.profiles
     where not (
       (role = 'owner' and institution_id is null)
       or (role <> 'owner' and institution_id is not null)
       or (institution_id is null and account_status in ('pending', 'rejected'))
     )
  ) then
    alter table public.profiles validate constraint profiles_role_institution_check;
  else
    raise notice 'profiles_role_institution_check left NOT VALID: existing rows need manual review';
  end if;
end
$constraint_repair$;

-- The original table check only allowed pending/active/suspended. The later
-- section of THE_TRAINERS_SETUP.sql adds rejected, but an existing project may
-- have the older constraint. Replace only when rejected is absent.
do $status_repair$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_account_status_check'
       and pg_get_constraintdef(oid) ilike '%rejected%'
  ) then
    alter table public.profiles drop constraint if exists profiles_account_status_check;
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('pending', 'active', 'rejected', 'suspended')) not valid;

    if not exists (
      select 1 from public.profiles
       where account_status not in ('pending', 'active', 'rejected', 'suspended')
    ) then
      alter table public.profiles validate constraint profiles_account_status_check;
    end if;
  end if;
end
$status_repair$;

-- ---------------------------------------------------------------------------
-- 2. Privilege guard: only Owner and Director can review accounts; nobody can
--    change their own role/institution/status; Director cannot change roles or
--    move accounts; Owner cannot promote a second owner.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_privileges() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare actor_role public.app_role; actor_institution uuid; begin
 if auth.uid() is null then return new; end if;
 if current_setting('app.account_repair', true) = 'on' then return new; end if;
 if old.id=auth.uid() then
  if new.role is distinct from old.role or new.institution_id is distinct from old.institution_id or new.account_status is distinct from old.account_status or new.email is distinct from old.email or new.created_by is distinct from old.created_by or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
   raise exception 'You cannot change your own role, institution or account status';
  end if;
  return new;
 end if;
 if new.role='owner' and old.role<>'owner' then raise exception 'The platform-owner role is provisioned by bootstrap only'; end if;
 if old.role='owner' then raise exception 'The platform-owner role cannot be reassigned or modified here'; end if;
 actor_role:=public.current_app_role();
 actor_institution:=public.current_institution_id();
 if actor_role='owner' then return new; end if;
 if actor_role<>'manager' then raise exception 'Insufficient permission'; end if;
 if actor_institution is null or old.institution_id is distinct from actor_institution then raise exception 'Insufficient permission'; end if;
 if old.role not in ('admin','coach') then raise exception 'Managers may review institution administrators and coaches only'; end if;
 if new.role is distinct from old.role then raise exception 'Managers cannot change account roles'; end if;
 if new.institution_id is distinct from old.institution_id then raise exception 'Managers cannot move accounts between institutions'; end if;
 if new.email is distinct from old.email or new.created_by is distinct from old.created_by then raise exception 'Protected profile fields'; end if;
 if new.account_status is distinct from old.account_status then
  if new.account_status='active' and old.account_status in ('pending','rejected') then
   if new.approved_by is distinct from auth.uid() or new.approved_at is null then raise exception 'Approval fields must record the approving manager'; end if;
  elsif new.account_status='rejected' and old.account_status in ('pending','active','suspended') then
   null;
  elsif new.account_status='suspended' and old.account_status='active' then
   null;
  elsif new.account_status='active' and old.account_status='suspended' then
   if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then raise exception 'Reactivation does not change approval fields'; end if;
  else
   raise exception 'Invalid account status transition';
  end if;
 elsif new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
  raise exception 'Approval fields can only be set during approval';
 end if;
 return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. ensure_my_profile(): signed-in Auth user with no profile gets a safe
--    coach/pending row. The exact confirmed owner email may bootstrap owner only
--    while no owner exists.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_my_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_meta_name text;
  v_confirmed boolean;
  v_owner_email constant text := 'ayoubmalleh772@gmail.com';
  v_other_owner boolean := false;
begin
  if v_uid is null then
    raise exception 'authentication_required';
  end if;

  select lower(coalesce(u.email, '')),
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), ''),
         u.email_confirmed_at is not null
    into v_email, v_meta_name, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if not found then
    raise exception 'auth_user_not_found';
  end if;

  -- Safe default. Role and institution are never read from sign-up metadata.
  insert into public.profiles (id, email, full_name, role, institution_id, account_status)
  values (v_uid, v_email, v_meta_name, 'coach', null, 'pending')
  on conflict (id) do nothing;

  if v_email = v_owner_email and coalesce(v_confirmed, false) then
    select exists (
      select 1 from public.profiles
       where role = 'owner' and id <> v_uid
    ) into v_other_owner;

    if not v_other_owner then
      perform set_config('app.account_repair', 'on', true);
      update public.profiles
         set role = 'owner',
             institution_id = null,
             account_status = case when account_status = 'pending' then 'active' else account_status end,
             updated_at = now()
       where id = v_uid and role <> 'owner';
      perform set_config('app.account_repair', 'off', true);
    end if;
  end if;

  return (select p from public.profiles p where p.id = v_uid);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. sync_missing_profiles(): Owner-only backfill for Auth users that have no
--    profile row, plus filling empty email/name fields. It never deletes or
--    overwrites non-empty data and never invents a role/institution.
-- ---------------------------------------------------------------------------
create or replace function public.sync_missing_profiles()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  if auth.uid() is null or not public.is_platform_owner() then
    return jsonb_build_object('ok', false, 'error', 'insufficient_permission');
  end if;

  insert into public.profiles (id, email, full_name, role, institution_id, account_status, created_at, updated_at)
  select u.id,
         lower(coalesce(u.email, '')),
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), ''),
         'coach',
         null,
         'pending',
         coalesce(u.created_at, now()),
         now()
    from auth.users u
    left join public.profiles p on p.id = u.id
   where p.id is null;

  get diagnostics v_inserted = row_count;

  perform set_config('app.account_repair', 'on', true);
  update public.profiles p
     set email = case when p.email = '' then lower(coalesce(u.email, '')) else p.email end,
         full_name = case
           when p.full_name = '' then coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), '')
           else p.full_name
         end,
         updated_at = now()
    from auth.users u
   where p.id = u.id
     and (p.email = '' or p.full_name = '');

  get diagnostics v_updated = row_count;
  perform set_config('app.account_repair', 'off', true);

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. review_account(): one atomic entry point for approve / reject / suspend /
--    reactivate / update.
--
--    Owner  : any non-owner account, platform-wide; may correct role,
--             institution and full name.
--    Manager: admin/coach accounts in their own institution only; may only
--             change status; cannot change role, institution or name.
--    Nobody : may review themselves or the owner account.
-- ---------------------------------------------------------------------------
create or replace function public.review_account(
  p_profile_id uuid,
  p_action text,
  p_role public.app_role default null,
  p_institution_id uuid default null,
  p_full_name text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role public.app_role;
  v_actor_institution uuid;
  v_actor_status text;
  v_target_role public.app_role;
  v_target_institution uuid;
  v_target_status text;
  v_target_name text;
  v_target_approved_by uuid;
  v_target_approved_at timestamptz;
  v_new_role public.app_role;
  v_new_institution uuid;
  v_new_status text;
  v_new_name text;
  v_new_approved_by uuid;
  v_new_approved_at timestamptz;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_reason text := left(coalesce(p_reason, ''), 200);
  v_old jsonb;
begin
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'authentication_required');
  end if;

  select p.role, p.institution_id, p.account_status, p.full_name, p.approved_by, p.approved_at
    into v_target_role, v_target_institution, v_target_status, v_target_name, v_target_approved_by, v_target_approved_at
    from public.profiles p
   where p.id = p_profile_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  select p.role, p.institution_id, p.account_status
    into v_actor_role, v_actor_institution, v_actor_status
    from public.profiles p
   where p.id = v_actor_id;

  if not found or v_actor_status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'active_profile_required');
  end if;

  if p_profile_id = v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'self_review_forbidden');
  end if;

  if v_target_role = 'owner' then
    return jsonb_build_object('ok', false, 'error', 'owner_protected');
  end if;

  if v_action not in ('approve', 'reject', 'suspend', 'reactivate', 'update') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
  end if;

  if v_actor_role = 'manager' then
    if v_actor_institution is null or v_target_institution is distinct from v_actor_institution then
      return jsonb_build_object('ok', false, 'error', 'institution_forbidden');
    end if;
    if v_target_role not in ('admin', 'coach') then
      return jsonb_build_object('ok', false, 'error', 'target_role_forbidden');
    end if;
    if p_role is not null and p_role is distinct from v_target_role then
      return jsonb_build_object('ok', false, 'error', 'role_change_forbidden');
    end if;
    if p_institution_id is not null and p_institution_id is distinct from v_target_institution then
      return jsonb_build_object('ok', false, 'error', 'institution_forbidden');
    end if;
    if p_full_name is not null then
      return jsonb_build_object('ok', false, 'error', 'profile_field_forbidden');
    end if;
    if v_action = 'update' then
      return jsonb_build_object('ok', false, 'error', 'role_change_forbidden');
    end if;
  elsif v_actor_role = 'owner' then
    if p_role = 'owner' then
      return jsonb_build_object('ok', false, 'error', 'owner_role_forbidden');
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'insufficient_permission');
  end if;

  v_new_role := coalesce(p_role, v_target_role);
  v_new_institution := coalesce(p_institution_id, v_target_institution);
  v_new_status := v_target_status;
  if v_actor_role = 'owner' and p_full_name is not null then
    v_new_name := left(trim(p_full_name), 120);
  else
    v_new_name := v_target_name;
  end if;
  v_new_approved_by := v_target_approved_by;
  v_new_approved_at := v_target_approved_at;

  if v_new_institution is not null then
    if not exists (select 1 from public.institutions i where i.id = v_new_institution) then
      return jsonb_build_object('ok', false, 'error', 'institution_not_found');
    end if;
  end if;

  if v_action = 'approve' then
    if v_target_status not in ('pending', 'rejected') then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
    v_new_status := 'active';
    if v_new_institution is null then
      return jsonb_build_object('ok', false, 'error', 'institution_required');
    end if;
    v_new_approved_by := v_actor_id;
    v_new_approved_at := now();
  elsif v_action = 'reject' then
    if v_target_status not in ('pending', 'active', 'suspended') then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
    v_new_status := 'rejected';
    v_new_approved_by := null;
    v_new_approved_at := null;
  elsif v_action = 'suspend' then
    if v_target_status <> 'active' then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
    v_new_status := 'suspended';
  elsif v_action = 'reactivate' then
    if v_target_status not in ('suspended', 'rejected') then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
    v_new_status := 'active';
    if v_new_institution is null then
      return jsonb_build_object('ok', false, 'error', 'institution_required');
    end if;
    v_new_approved_by := coalesce(v_target_approved_by, v_actor_id);
    v_new_approved_at := coalesce(v_target_approved_at, now());
  else
    -- update: status is intentionally unchanged. Only Owner reaches here.
    null;
  end if;

  if v_new_status in ('active', 'suspended') and v_new_institution is null then
    return jsonb_build_object('ok', false, 'error', 'institution_required');
  end if;

  v_old := jsonb_build_object(
    'role', v_target_role::text,
    'institution_id', v_target_institution,
    'account_status', v_target_status,
    'full_name', v_target_name
  );

  perform set_config('app.account_repair', 'on', true);
  update public.profiles
     set role = v_new_role,
         institution_id = v_new_institution,
         account_status = v_new_status,
         full_name = v_new_name,
         approved_by = v_new_approved_by,
         approved_at = v_new_approved_at,
         updated_at = now()
   where id = p_profile_id;
  perform set_config('app.account_repair', 'off', true);

  insert into public.audit_logs (
    institution_id, actor_id, action, table_name, record_id, old_data, new_data
  ) values (
    coalesce(v_new_institution, v_target_institution),
    v_actor_id,
    'account_' || v_action,
    'profiles',
    p_profile_id::text,
    v_old,
    jsonb_build_object(
      'role', v_new_role::text,
      'institution_id', v_new_institution,
      'account_status', v_new_status,
      'full_name', v_new_name,
      'reason', nullif(v_reason, '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'profile_id', p_profile_id,
    'role', v_new_role::text,
    'institution_id', v_new_institution,
    'account_status', v_new_status
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. my_pending_invitation(): returns the caller's own live pending invitation
--    so the gate knows whether an OTP can actually be redeemed. It never
--    returns OTP rows or another person's invitation.
-- ---------------------------------------------------------------------------
create or replace function public.my_pending_invitation()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_row record;
begin
  if v_uid is null then
    return null;
  end if;

  select lower(coalesce(u.email, ''))
    into v_email
    from auth.users u
   where u.id = v_uid;

  if coalesce(v_email, '') = '' then
    return null;
  end if;

  select i.id,
         i.role,
         i.institution_id,
         i.invited_email,
         i.invited_name,
         i.delivery_method,
         i.expires_at,
         inst.name as institution_name
    into v_row
    from public.invitations i
    left join public.institutions inst on inst.id = i.institution_id
   where i.status = 'pending'
     and i.expires_at > now()
     and lower(coalesce(i.invited_email, '')) = v_email
   order by i.created_at desc, i.id desc
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'role', v_row.role::text,
    'institution_id', v_row.institution_id,
    'institution_name', v_row.institution_name,
    'invited_email', v_row.invited_email,
    'invited_name', v_row.invited_name,
    'delivery_method', v_row.delivery_method::text,
    'expires_at', v_row.expires_at
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. RLS replacement
-- ---------------------------------------------------------------------------
-- Only Owner and Director may review accounts. Administration and Coach cannot
-- update another profile through PostgREST.
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
using (
  public.is_platform_owner()
  or (
    public.current_app_role() = 'manager'
    and institution_id = public.current_institution_id()
    and role in ('admin', 'coach')
  )
)
with check (
  public.is_platform_owner()
  or (
    public.current_app_role() = 'manager'
    and institution_id = public.current_institution_id()
    and role in ('admin', 'coach')
  )
);

-- The owner sees the platform-wide audit log. Institution managers/admins keep
-- their institution-scoped view.
drop policy if exists audit_read_admin on public.audit_logs;
create policy audit_read_admin on public.audit_logs for select to authenticated
using (
  public.is_platform_owner()
  or (
    institution_id = public.current_institution_id()
    and public.current_app_role() in ('manager', 'admin')
  )
);

-- Only Owner and Director can read invitations. Admin/Coach cannot.
drop policy if exists invitations_select_admin on public.invitations;
create policy invitations_select_admin on public.invitations for select to authenticated
using (
  public.is_platform_owner()
  or (
    institution_id = public.current_institution_id()
    and public.current_app_role() = 'manager'
  )
);

-- ---------------------------------------------------------------------------
-- 8. Patch the old OTP acceptance function if it still auto-activates accounts.
--    The corrected INVITATIONS_OTP_INCREMENTAL.sql is used for fresh installs;
--    this block repairs an already-installed old function in place.
-- ---------------------------------------------------------------------------
do $otp_patch$
declare
  v_def text;
  v_changed boolean := false;
begin
  v_def := pg_get_functiondef('public.verify_otp_code(uuid, text, uuid)'::regprocedure);

  if position('account_status = ''active''' in v_def) > 0 then
    v_def := replace(
      v_def,
      'account_status = ''active'',',
      'account_status = CASE WHEN v_profile_status = ''active'' AND v_profile_institution_id = v_institution_id THEN ''active'' ELSE ''pending'' END,'
    );
    v_changed := true;
  end if;

  if position('approved_by = COALESCE(v_inviter_id, approved_by),' in v_def) > 0 then
    v_def := replace(
      v_def,
      'approved_by = COALESCE(v_inviter_id, approved_by),',
      'approved_by = CASE WHEN v_profile_status = ''active'' AND v_profile_institution_id = v_institution_id THEN approved_by ELSE NULL END,'
    );
    v_changed := true;
  end if;

  if position('approved_at = now(),' in v_def) > 0 then
    v_def := replace(
      v_def,
      'approved_at = now(),',
      'approved_at = CASE WHEN v_profile_status = ''active'' AND v_profile_institution_id = v_institution_id THEN approved_at ELSE NULL END,'
    );
    v_changed := true;
  end if;

  if v_changed then
    execute v_def;
  end if;

  v_def := pg_get_functiondef('public.verify_otp_code(uuid, text, uuid)'::regprocedure);
  if position('account_status = ''active''' in v_def) > 0 then
    raise exception 'verify_otp_code still auto-activates accounts after the repair';
  end if;
end
$otp_patch$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.ensure_my_profile() from public, anon;
revoke all on function public.sync_missing_profiles() from public, anon;
revoke all on function public.review_account(uuid, text, public.app_role, uuid, text, text) from public, anon;
revoke all on function public.my_pending_invitation() from public, anon;

grant execute on function public.ensure_my_profile() to authenticated, service_role;
grant execute on function public.sync_missing_profiles() to authenticated, service_role;
grant execute on function public.review_account(uuid, text, public.app_role, uuid, text, text) to authenticated, service_role;
grant execute on function public.my_pending_invitation() to authenticated, service_role;

-- Keep the profile audit trail and updated_at trigger present on projects that
-- were built from an older setup file.
do $triggers$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'profiles_audit'
       and tgrelid = 'public.profiles'::regclass
  ) then
    execute 'create trigger profiles_audit after insert or update or delete on public.profiles for each row execute function public.write_audit_log()';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'profiles_set_updated_at'
       and tgrelid = 'public.profiles'::regclass
  ) then
    execute 'create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at()';
  end if;
end
$triggers$;

-- ---------------------------------------------------------------------------
-- 10. Post-checks
-- ---------------------------------------------------------------------------
do $post$
declare
  v_guard text;
  v_invitation_qual text;
  v_profile_qual text;
  v_audit_qual text;
  v_review text;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_role_institution_check'
       and pg_get_constraintdef(oid) ilike '%rejected%'
  ) then
    raise exception 'profiles_role_institution_check is missing or does not allow rejected accounts';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_account_status_check'
       and pg_get_constraintdef(oid) ilike '%rejected%'
  ) then
    raise exception 'profiles_account_status_check does not allow rejected';
  end if;

  if to_regprocedure('public.ensure_my_profile()') is null
     or to_regprocedure('public.sync_missing_profiles()') is null
     or to_regprocedure('public.my_pending_invitation()') is null
     or to_regprocedure('public.review_account(uuid, text, public.app_role, uuid, text, text)') is null then
    raise exception 'One or more account repair RPCs are missing';
  end if;

  v_guard := pg_get_functiondef('public.guard_profile_privileges()'::regprocedure);
  if position('app.account_repair' in v_guard) = 0
     or position('Managers cannot change account roles' in v_guard) = 0
     or position('You cannot change your own role, institution or account status' in v_guard) = 0 then
    raise exception 'The privilege guard was not updated';
  end if;

  select qual into v_invitation_qual
    from pg_policies
   where schemaname = 'public' and tablename = 'invitations' and policyname = 'invitations_select_admin';
  if v_invitation_qual is null
     or position('manager' in v_invitation_qual) = 0
     or position('''admin''' in v_invitation_qual) > 0 then
    raise exception 'Invitation RLS still allows a role other than Owner/Director';
  end if;

  select qual into v_profile_qual
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_admin_update';
  if v_profile_qual is null or position('manager' in v_profile_qual) = 0 then
    raise exception 'profiles_admin_update was not restricted to Owner/Director';
  end if;

  select qual into v_audit_qual
    from pg_policies
   where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_read_admin';
  if v_audit_qual is null or position('is_platform_owner' in v_audit_qual) = 0 then
    raise exception 'Owner audit visibility was not expanded';
  end if;

  v_review := pg_get_functiondef('public.review_account(uuid, text, public.app_role, uuid, text, text)'::regprocedure);
  if position('self_review_forbidden' in v_review) = 0
     or position('institution_forbidden' in v_review) = 0
     or position('owner_protected' in v_review) = 0
     or position('role_change_forbidden' in v_review) = 0 then
    raise exception 'review_account is missing one of its protection checks';
  end if;

  if has_function_privilege('anon', 'public.review_account(uuid,text,public.app_role,uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.ensure_my_profile()', 'execute')
     or has_function_privilege('anon', 'public.sync_missing_profiles()', 'execute')
     or has_function_privilege('anon', 'public.my_pending_invitation()', 'execute') then
    raise exception 'A repair RPC is executable by anon';
  end if;
end
$post$;

commit;

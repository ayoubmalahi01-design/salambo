-- THE TRAINERS / TADARRAB — production-oriented fresh-project schema
-- Run ONLY in a NEW, dedicated Supabase project. Never run in Sport Performance.
-- Owner bootstrap email: ayoubmalleh772@gmail.com
begin;
create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('owner','manager','admin','coach');
exception when duplicate_object then null; end $$;

create table if not exists public.institutions (
 id uuid primary key default gen_random_uuid(), name text not null,
 logo_path text, phone text, email text, address text,
 default_language text not null default 'ar' check(default_language in ('ar','fr','en')),
 is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 institution_id uuid references public.institutions(id) on delete restrict,
 full_name text not null default '', email text not null default '',
 role public.app_role not null default 'coach',
 account_status text not null default 'pending' check(account_status in ('pending','active','suspended')),
 preferred_language text not null default 'ar' check(preferred_language in ('ar','fr','en')),
 phone text, avatar_path text, created_by uuid references public.profiles(id),
 approved_by uuid references public.profiles(id), approved_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 -- A non-owner account needs an institution before it can be active. Pending and
 -- rejected accounts may temporarily have no institution while the owner repairs
 -- an Auth/profile link; this is the safe state used by the repair RPCs.
 constraint profiles_role_institution_check check (
  (role='owner' and institution_id is null)
  or (role<>'owner' and institution_id is not null)
  or (institution_id is null and account_status in ('pending','rejected'))
 )
);
create index if not exists profiles_institution_role on public.profiles(institution_id,role,account_status);

create table if not exists public.classes (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 name text not null, academic_year text, description text, created_at timestamptz not null default now(),
 unique(institution_id,name,academic_year)
);
create table if not exists public.students (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 class_id uuid references public.classes(id) on delete set null, student_code text not null, full_name text not null,
 date_of_birth date, gender text check(gender in ('female','male','other')),
 is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(institution_id,student_code)
);
create index if not exists students_name_search on public.students(institution_id,full_name);
create table if not exists public.student_medical_records (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 student_id uuid not null references public.students(id) on delete cascade,
 record_type text not null check(record_type in ('medical','injury','exemption','permission','other')),
 details text not null, start_date date, end_date date, attachment_path text,
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.coach_shifts (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 coach_id uuid not null references public.profiles(id) on delete restrict,
 started_at timestamptz not null default now(), ended_at timestamptz,
 notes text, created_at timestamptz not null default now(), check(ended_at is null or ended_at>=started_at)
);
create unique index if not exists one_open_shift_per_coach on public.coach_shifts(coach_id) where ended_at is null;
create table if not exists public.daily_reports (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 coach_id uuid not null references public.profiles(id) on delete restrict, shift_id uuid references public.coach_shifts(id) on delete set null,
 coach_name_snapshot text not null, report_date date not null default current_date,
 shift_start timestamptz, shift_end timestamptz,
 present_count int not null default 0 check(present_count>=0), absent_count int not null default 0 check(absent_count>=0),
 late_count int not null default 0 check(late_count>=0), injured_count int not null default 0 check(injured_count>=0),
 excused_count int not null default 0 check(excused_count>=0), notes text,
 status text not null default 'draft' check(status in ('draft','submitted','reviewed')),
 is_finalized boolean not null default false, finalized_at timestamptz, reviewed_by uuid references public.profiles(id), reviewed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists reports_coach_date on public.daily_reports(coach_id,report_date desc);
-- Word template storage for institution-specific report templates
create table if not exists public.report_templates (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 file_name text not null, file_path text not null, version int not null default 1,
 is_current boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint current_template_per_institution unique (institution_id) where is_current = true
);
-- Report export log for tracking downloads
create table if not exists public.report_exports (
 id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id) on delete cascade,
 report_id uuid not null references public.daily_reports(id) on delete cascade,
 exported_by uuid not null references public.profiles(id) on delete cascade,
 export_type text not null check(export_type in ('single','institution','all','template')),
 exported_at timestamptz not null default now(), file_name text, file_path text
);
-- Institution-level audit for template changes
create or replace function public.write_audit_log() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare v_old jsonb; v_new jsonb; v_inst uuid; v_id text; begin
 if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
 if tg_table_name='report_templates' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
 end if;
 if tg_table_name='report_exports' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
 end if;
 v_id:=coalesce(v_new->>'id',v_old->>'id');
 insert into public.audit_logs(institution_id,actor_id,action,table_name,record_id,old_data,new_data)
 values(v_inst,auth.uid(),tg_op,tg_table_name,v_id,v_old,v_new);
 if tg_op='DELETE' then return old; else return new; end if;
 end $$;
 do $$ declare t text; begin foreach t in array array['report_templates','report_exports'] loop
  execute format('drop trigger if exists %I on public.%I',t||'_audit',t);
  execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()',t||'_audit',t);
 end loop; end $$;

-- Identity and authorization helpers. SECURITY DEFINER functions.
create or replace function public.my_profile() returns public.profiles
language sql stable security definer set search_path=public,pg_temp
as $$ select p from public.profiles p where p.id=auth.uid() and p.account_status='active' limit 1 $$;
create or replace function public.current_institution_id() returns uuid
language sql stable security definer set search_path=public,pg_temp
as $$ select institution_id from public.profiles where id=auth.uid() and account_status='active' $$;
create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path=public,pg_temp
as $$ select role from public.profiles where id=auth.uid() and account_status='active' $$;
create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$ select exists(select 1 from public.profiles where id=auth.uid() and role='owner' and account_status='active') $$;
create or replace function public.is_institution_admin() returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$ select public.current_app_role() in ('manager','admin','owner') $$;
create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$ select exists(select 1 from public.profiles where id=auth.uid() and account_status='active') $$;
create or replace function public.is_conversation_member(cid uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$ select exists(select 1 from public.conversation_members cm where cm.conversation_id=cid and cm.profile_id=auth.uid()) $$;

-- Daily reports and templates are per-institution. Identity and authorization.
-- Identity and authorization helpers. SECURITY DEFINER functions have fixed search_path.
create or replace function public.create_conversation(p_title text default null,p_member_ids uuid[] default '{}')
returns uuid language plpgsql security definer set search_path=public,pg_temp
as $$
 declare v_institution uuid; v_id uuid; v_type text; v_count integer;
 begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select institution_id into v_institution from public.profiles where id=auth.uid() and account_status='active';
  if v_institution is null then raise exception 'Active institution membership required'; end if;
  select count(distinct x) into v_count from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x<>auth.uid();
  if v_count<1 then raise exception 'Select at least one other member'; end if;
  if v_count>100 then raise exception 'A conversation can have at most 100 other members'; end if;
  if exists(select 1 from unnest(coalesce(p_member_ids,'{}'::uuid[])) x left join public.profiles p on p.id=x and p.institution_id=v_institution and p.account_status='active' where x<>auth.uid() and p.id is null) then
   raise exception 'Every participant must be an active member of your institution';
  end if;
  v_type:=case when v_count=1 and nullif(trim(coalesce(p_title,'')),'') is null then 'direct' else 'group' end;
  insert into public.conversations(institution_id,title,conversation_type,created_by) values(v_institution,nullif(trim(coalesce(p_title,'')),''),v_type,auth.uid()) returning id into v_id;
  insert into public.conversation_members(conversation_id,profile_id) values(v_id,auth.uid()) on conflict do nothing;
  insert into public.conversation_members(conversation_id,profile_id) select v_id,x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x on conflict do nothing;
  return v_id;
end $$;

-- Owner bootstrap: only the configured e-mail can receive the platform-owner
-- role, and only after that e-mail is confirmed. The role is never read from
-- user-supplied metadata, so a sign-up cannot promote itself.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare
 v_owner_email constant text := 'ayoubmalleh772@gmail.com';
 v_role public.app_role;
 v_owner boolean;
 v_confirmed boolean;
 begin
  v_owner := lower(coalesce(new.email,'')) = v_owner_email;
  v_confirmed := new.email_confirmed_at is not null;
  v_role := case when v_owner then 'owner'::public.app_role else 'coach'::public.app_role end;
  if v_owner and exists(select 1 from public.profiles where role='owner' and id<>new.id) then
   raise exception 'A platform owner already exists';
  end if;
  insert into public.profiles(id,email,full_name,role,institution_id,account_status)
  values(new.id,lower(coalesce(new.email,'')),coalesce(new.raw_user_meta_data->>'full_name',''),v_role,null,
  case when v_owner and v_confirmed then 'active' else 'pending' end)
  on conflict(id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_auth_user();

-- Activate a pending owner only when the owner e-mail is actually confirmed.
create or replace function public.confirm_platform_owner() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if lower(coalesce(new.email,''))='ayoubmalleh772@gmail.com' and new.email_confirmed_at is not null then
  update public.profiles set account_status='active',updated_at=now()
   where id=new.id and role='owner' and account_status='pending';
 end if;
 return new;
end $$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
 for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
 execute function public.confirm_platform_owner();

-- Protect role, institution and activation fields from self-promotion.
-- Final rule set:
--   * owner  : may review any non-owner account and may correct its role or
--              institution; the owner account itself is immutable here;
--   * manager: may approve/reject/suspend/reactivate admin and coach accounts
--              inside the manager's own institution only; may never change a
--              role or move an account to another institution;
--   * admin  : may not manage other accounts at all;
--   * coach  : may not manage other accounts at all;
--   * nobody : may change their own role, institution or status.
--
-- `review_account()` and `ensure_my_profile()` mark their transaction with
-- `app.account_repair=on` after performing the same checks server-side, so the
-- two trusted repair paths do not trip this trigger.
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
drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard before update on public.profiles for each row execute function public.guard_profile_privileges();

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path=public,pg_temp
as $$ begin new.updated_at=now(); return new; end $$;
do $$ declare t text; begin foreach t in array array['institutions','profiles','students','student_notes','coach_notebooks','daily_reports','report_templates','report_exports'] loop
 execute format('drop trigger if exists %I on public.%I',t||'_set_updated_at',t);
 execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',t||'_set_updated_at',t);
 end loop; end $$;

-- Audit selected business-table mutations, storing before/after snapshots.
create or replace function public.write_audit_log() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare v_old jsonb; v_new jsonb; v_inst uuid; v_id text; begin
 if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
 -- Medical details are deliberately redacted from the platform-wide audit view.
 if tg_table_name='student_medical_records' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{details}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{details}','"[REDACTED]"'::jsonb,true); end if;
 elsif tg_table_name='student_notes' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{body}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{body}','"[REDACTED]"'::jsonb,true); end if;
 elsif tg_table_name='daily_reports' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{notes}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{notes}','"[REDACTED]"'::jsonb,true); end if;
 elsif tg_table_name='report_templates' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
 elsif tg_table_name='report_exports' then
  if v_old is not null then v_old:=jsonb_set(v_old,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
  if v_new is not null then v_new:=jsonb_set(v_new,'{file_path}','"[REDACTED]"'::jsonb,true); end if;
 elsif tg_table_name='students' then
  if v_old is not null then v_old:=v_old-'date_of_birth'; end if;
  if v_new is not null then v_new:=v_new-'date_of_birth'; end if;
 elsif tg_table_name='attendance_records' then
  if v_old is not null then v_old:=v_old-'reason'; end if;
  if v_new is not null then v_new:=v_new-'reason'; end if;
 elsif tg_table_name='profiles' then
  if v_old is not null then v_old:=v_old-'phone'; end if;
  if v_new is not null then v_new:=v_new-'phone'; end if;
 end if;
 if tg_table_name='institutions' then v_inst:=coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid); else v_inst:=coalesce((v_new->>'institution_id')::uuid,(v_old->>'institution_id')::uuid); end if;
 v_id:=coalesce(v_new->>'id',v_old->>'id');
 insert into public.audit_logs(institution_id,actor_id,action,table_name,record_id,old_data,new_data)
 values(v_inst,auth.uid(),tg_op,tg_table_name,v_id,v_old,v_new);
 if tg_op='DELETE' then return old; else return new; end if;
 end $$;
 do $$ declare t text; begin foreach t in array array['institutions','students','coach_shifts','daily_reports','attendance_records','student_medical_records','student_notes','admin_notices','profiles','report_templates','report_exports'] loop
  execute format('drop trigger if exists %I on public.%I',t||'_audit',t);
  execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()',t||'_audit',t);
 end loop; end $$;

-- Coaches cannot edit finalized reports; institution administrators may only mark them reviewed.
create or replace function public.lock_final_report() returns trigger language plpgsql set search_path=public,pg_temp
as $$ begin
 if old.is_finalized then
  if public.current_app_role() in ('manager','admin')
     and new.id is not distinct from old.id
     and new.institution_id is not distinct from old.institution_id
     and new.coach_id is not distinct from old.coach_id
     and new.shift_id is not distinct from old.shift_id
     and new.coach_name_snapshot is not distinct from old.coach_name_snapshot
     and new.report_date is not distinct from old.report_date
     and new.shift_start is not distinct from old.shift_start
     and new.shift_end is not distinct from old.shift_end
     and new.present_count is not distinct from old.present_count
     and new.absent_count is not distinct from old.absent_count
     and new.late_count is not distinct from old.late_count
     and new.injured_count is not distinct from old.injured_count
     and new.excused_count is not distinct from old.excused_count
     and new.notes is not distinct from old.notes
     and new.is_finalized is true and new.finalized_at is not distinct from old.finalized_at
     and new.status='reviewed' and new.reviewed_by=auth.uid() and new.reviewed_at is not null then
    return new;
  end if;
  raise exception 'Finalized reports are immutable';
 end if;
 if new.is_finalized and new.finalized_at is null then new.finalized_at=now(); end if;
 return new;
end $$;
drop trigger if exists daily_report_lock on public.daily_reports;
create trigger daily_report_lock before update on public.daily_reports for each row execute function public.lock_final_report();

-- Cross-tenant relationship guards. RLS constrains who may write; these triggers
-- constrain what may be written, so two institutions can never be linked even
-- through a trusted RPC, a service-role import or a future client bug.
create or replace function public.guard_student_class() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if new.class_id is not null and not exists(select 1 from public.classes c where c.id=new.class_id and c.institution_id=new.institution_id) then
  raise exception 'Class and student must belong to the same institution';
 end if;
 return new;
end $$;
drop trigger if exists students_class_guard on public.students;
create trigger students_class_guard before insert or update of class_id,institution_id on public.students for each row execute function public.guard_student_class();

create or replace function public.guard_attendance_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.students s where s.id=new.student_id and s.institution_id=new.institution_id) then
  raise exception 'Attendance student must belong to the same institution';
 end if;
 if not exists(select 1 from public.profiles p where p.id=new.coach_id and p.institution_id=new.institution_id and p.account_status in ('active','suspended')) then
  raise exception 'Attendance coach must be an established member of the same institution';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.student_id is distinct from old.student_id or new.coach_id is distinct from old.coach_id or new.session_date is distinct from old.session_date or new.session_key is distinct from old.session_key) then
  raise exception 'Attendance identity is immutable; correct status or reason only';
 end if;
 return new;
end $$;
drop trigger if exists attendance_relation_guard on public.attendance_records;
create trigger attendance_relation_guard before insert or update of institution_id,student_id,coach_id,session_date,session_key on public.attendance_records for each row execute function public.guard_attendance_relation();

create or replace function public.guard_student_note_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.students s where s.id=new.student_id and s.institution_id=new.institution_id) then
  raise exception 'Note student must belong to the same institution';
 end if;
 if not exists(select 1 from public.profiles p where p.id=new.author_id and p.institution_id=new.institution_id and p.account_status='active') then
  raise exception 'Note author must be an active member of the same institution';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.student_id is distinct from old.student_id or new.author_id is distinct from old.author_id) then
  raise exception 'Note identity is immutable';
 end if;
 return new;
end $$;
drop trigger if exists student_notes_relation_guard on public.student_notes;
create trigger student_notes_relation_guard before insert or update of institution_id,student_id,author_id on public.student_notes for each row execute function public.guard_student_note_relation();

create or replace function public.guard_medical_record_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.students s where s.id=new.student_id and s.institution_id=new.institution_id) then
  raise exception 'Medical record student must belong to the same institution';
 end if;
 if not exists(select 1 from public.profiles p where p.id=new.created_by and p.institution_id=new.institution_id and p.account_status='active') then
  raise exception 'Medical record author must be an active member of the same institution';
 end if;
 if new.attachment_path is not null and new.attachment_path not like new.institution_id::text||'/%' then
  raise exception 'Medical attachment must live under the institution folder';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.student_id is distinct from old.student_id or new.created_by is distinct from old.created_by) then
  raise exception 'Medical record identity is immutable';
 end if;
 return new;
end $$;
drop trigger if exists medical_record_relation_guard on public.student_medical_records;
create trigger medical_record_relation_guard before insert or update of institution_id,student_id,created_by,attachment_path on public.student_medical_records for each row execute function public.guard_medical_record_relation();

create or replace function public.guard_daily_report_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.profiles p where p.id=new.coach_id and p.institution_id=new.institution_id and p.role='coach' and p.account_status='active') then
  raise exception 'Report coach must be an active coach of the same institution';
 end if;
 if new.shift_id is not null and not exists(select 1 from public.coach_shifts s where s.id=new.shift_id and s.coach_id=new.coach_id and s.institution_id=new.institution_id) then
  raise exception 'Report shift must belong to the same coach and institution';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.coach_id is distinct from old.coach_id or new.shift_id is distinct from old.shift_id) then
  raise exception 'Report identity is immutable';
 end if;
 return new;
end $$;
drop trigger if exists daily_report_relation_guard on public.daily_reports;
create trigger daily_report_relation_guard before insert or update of institution_id,coach_id,shift_id on public.daily_reports for each row execute function public.guard_daily_report_relation();

create or replace function public.guard_coach_shift_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.profiles p where p.id=new.coach_id and p.institution_id=new.institution_id and p.role='coach' and p.account_status='active') then
  raise exception 'Shift coach must be an active coach of the same institution';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.coach_id is distinct from old.coach_id) then
  raise exception 'Shift identity is immutable';
 end if;
 return new;
end $$;
drop trigger if exists coach_shift_relation_guard on public.coach_shifts;
create trigger coach_shift_relation_guard before insert or update of institution_id,coach_id on public.coach_shifts for each row execute function public.guard_coach_shift_relation();

create or replace function public.guard_message_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.conversations c where c.id=new.conversation_id and c.institution_id=new.institution_id) then
  raise exception 'Message conversation must belong to the same institution';
 end if;
 if not exists(select 1 from public.conversation_members cm where cm.conversation_id=new.conversation_id and cm.profile_id=new.sender_id) then
  raise exception 'Message sender must be a member of the conversation';
 end if;
 if tg_op='UPDATE' and (new.institution_id is distinct from old.institution_id or new.conversation_id is distinct from old.conversation_id or new.sender_id is distinct from old.sender_id) then
  raise exception 'Message identity is immutable';
 end if;
 return new;
end $$;
drop trigger if exists message_relation_guard on public.messages;
create trigger message_relation_guard before insert or update of institution_id,conversation_id,sender_id on public.messages for each row execute function public.guard_message_relation();

create or replace function public.guard_conversation_member_relation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.conversations c join public.profiles p on p.id=new.profile_id where c.id=new.conversation_id and p.institution_id=c.institution_id and p.account_status='active') then
  raise exception 'Conversation member must be an active member of the conversation institution';
 end if;
 return new;
end $$;
drop trigger if exists conversation_member_relation_guard on public.conversation_members;
create trigger conversation_member_relation_guard before insert on public.conversation_members for each row execute function public.guard_conversation_member_relation();

create or replace function public.guard_conversation_creator() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if not exists(select 1 from public.profiles p where p.id=new.created_by and p.institution_id=new.institution_id and p.account_status='active') then
  raise exception 'Conversation creator must be an active member of the same institution';
 end if;
 return new;
end $$;
drop trigger if exists conversation_creator_guard on public.conversations;
create trigger conversation_creator_guard before insert on public.conversations for each row execute function public.guard_conversation_creator();

create or replace function public.guard_institution_activation() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 if auth.uid() is not null and new.is_active is distinct from old.is_active and public.current_app_role()<>'manager' and not public.is_platform_owner() then
  raise exception 'Only the institution manager or the platform owner may change institution activation';
 end if;
 return new;
end $$;
drop trigger if exists institution_activation_guard on public.institutions;
create trigger institution_activation_guard before update on public.institutions for each row execute function public.guard_institution_activation();

-- =============================================================
-- REPORT TEMPLATES & EXPORT POLICIES
-- =============================================================

-- Platform owner can see/manage institutions. Members only see their own institution.
drop policy if exists institutions_select on public.institutions;
create policy institutions_select on public.institutions for select to authenticated using(id=public.current_institution_id() or public.is_platform_owner());
drop policy if exists institutions_owner_insert on public.institutions;
create policy institutions_owner_insert on public.institutions for insert to authenticated with check(public.is_platform_owner());
drop policy if exists institutions_owner_update on public.institutions;
create policy institutions_owner_update on public.institutions for update to authenticated using(public.is_platform_owner()) with check(public.is_platform_owner());
drop policy if exists institutions_manager_update on public.institutions;
create policy institutions_manager_update on public.institutions for update to authenticated using(id=public.current_institution_id() and public.current_app_role() in ('manager','admin')) with check(id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));

-- == Profile policies (preserved from previous repair) ==
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using(id=auth.uid() or public.is_platform_owner() or (institution_id=public.current_institution_id() and public.is_active_member()));
drop policy if exists profiles_update_self_safe on public.profiles;
create policy profiles_update_self_safe on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
using (
 public.is_platform_owner()
 or (
  public.current_app_role()='manager'
  and institution_id=public.current_institution_id()
  and role in ('admin','coach')
 )
)
with check (
 public.is_platform_owner()
 or (
  public.current_app_role()='manager'
  and institution_id=public.current_institution_id()
  and role in ('admin','coach')
 )
);
-- Owner profiles are created only by the auth bootstrap function; even the
-- platform owner cannot insert a second owner through the API.
drop policy if exists profiles_owner_insert on public.profiles;
create policy profiles_owner_insert on public.profiles for insert to authenticated with check(public.is_platform_owner() and role<>'owner');

-- Common institution read policies.
drop policy if exists classes_read on public.classes;
create policy classes_read on public.classes for select to authenticated using(institution_id=public.current_institution_id());
drop policy if exists classes_admin_write on public.classes;
create policy classes_admin_write on public.classes for all to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin());
drop policy if exists students_read on public.students;
create policy students_read on public.students for select to authenticated using(institution_id=public.current_institution_id());
drop policy if exists students_admin_write on public.students;
create policy students_admin_write on public.students for all to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and (class_id is null or exists(select 1 from public.classes c where c.id=class_id and c.institution_id=institution_id)));

drop policy if exists medical_admin_read on public.student_medical_records;
create policy medical_admin_read on public.student_medical_records for select to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin());
drop policy if exists medical_admin_insert on public.student_medical_records;
create policy medical_admin_insert on public.student_medical_records for insert to authenticated with check(institution_id=public.current_institution_id() and public.is_institution_admin() and created_by=auth.uid() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));
drop policy if exists medical_admin_update on public.student_medical_records;
create policy medical_admin_update on public.student_medical_records for update to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));
drop policy if exists medical_admin_delete on public.student_medical_records;
create policy medical_admin_delete on public.student_medical_records for delete to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin());

drop policy if exists shifts_read_own_admin on public.coach_shifts;
create policy shifts_read_own_admin on public.coach_shifts for select to authenticated using(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin()));
drop policy if exists shifts_insert_own on public.coach_shifts;
create policy shifts_insert_own on public.coach_shifts for insert to authenticated with check(institution_id=public.current_institution_id() and coach_id=auth.uid() and public.current_app_role()='coach');
drop policy if exists shifts_update_own_admin on public.coach_shifts;
create policy shifts_update_own_admin on public.coach_shifts for update to authenticated using(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin())) with check(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin()));

-- == Daily Reports Policies ==

-- Coaches can only see and edit their own daily reports
drop policy if exists reports_read_own_admin on public.daily_reports;
create policy reports_read_own_admin on public.daily_reports for select to authenticated using(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin()));

-- Coaches can insert their own daily reports (draft status)
drop policy if exists reports_insert_own on public.daily_reports;
create policy reports_insert_own on public.daily_reports for insert to authenticated with check(institution_id=public.current_institution_id() and coach_id=auth.uid() and public.current_app_role()='coach');

-- Coaches can update their own draft reports (not finalized)
drop policy if exists reports_update_own_draft on public.daily_reports;
create policy reports_update_own_draft on public.daily_reports for update to authenticated using(institution_id=public.current_institution_id() and coach_id=auth.uid() and not is_finalized) with check(institution_id=public.current_institution_id() and coach_id=auth.uid());

-- Institution administrators may mark reports as reviewed
drop policy if exists reports_admin_review on public.daily_reports;
create policy reports_admin_review on public.daily_reports for update to authenticated using(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin') and is_finalized) with check(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin') and is_finalized);

-- Platform owner can see all reports but cannot edit them (the trigger lock blocks edits)
drop policy if exists reports_owner_read_all on public.daily_reports;
create policy reports_owner_read_all on public.daily_reports for select to authenticated using(public.is_platform_owner());

-- == Report Template Policies ==

-- Only institution administrators can manage their templates
drop policy if exists report_templates_select on public.report_templates;
create policy report_templates_select on public.report_templates for select to authenticated using(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));
drop policy if exists report_templates_insert on public.report_templates;
create policy report_templates_insert on public.report_templates for insert to authenticated with check(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));
drop policy if exists report_templates_update on public.report_templates;
create policy report_templates_update on public.report_templates for update to authenticated using(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin')) with check(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));
drop policy if exists report_templates_delete on public.report_templates;
create policy report_templates_delete on public.report_templates for delete to authenticated using(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));

-- Platform owner can see all templates
drop policy if exists report_templates_owner_view on public.report_templates;
create policy report_templates_owner_view on public.report_templates for select to authenticated using(public.is_platform_owner());

-- == Report Export Policies ==

-- Institution admins can export their reports
drop policy if exists report_exports_institution on public.report_exports;
create policy report_exports_institution on public.report_exports for select to authenticated using(institution_id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));
drop policy if exists report_exports_owner_view on public.report_exports;
create policy report_exports_owner_view on public.report_exports for select to authenticated using(public.is_platform_owner());

-- == Institution policies (preserved) ==
drop policy if exists institutions_select on public.institutions;
create policy institutions_select on public.institutions for select to authenticated using(id=public.current_institution_id() or public.is_platform_owner());
drop policy if exists institutions_owner_insert on public.institutions;
create policy institutions_owner_insert on public.institutions for insert to authenticated with check(public.is_platform_owner());
drop policy if exists institutions_owner_update on public.institutions;
create policy institutions_owner_update on public.institutions for update to authenticated using(public.is_platform_owner()) with check(public.is_platform_owner());
drop policy if exists institutions_manager_update on public.institutions;
create policy institutions_manager_update on public.institutions for update to authenticated using(id=public.current_institution_id() and public.current_app_role() in ('manager','admin')) with check(id=public.current_institution_id() and public.current_app_role() in ('manager','admin'));

-- == Audit log policies (preserved) ==
drop policy if exists audit_read_admin on public.audit_logs;
create policy audit_read_admin on public.audit_logs for select to authenticated
using (
 public.is_platform_owner()
 or (
  institution_id = public.current_institution_id()
  and public.current_app_role() in ('manager', 'admin')
 )
);

-- == Shift policies (preserved) ==
drop policy if exists shifts_read_own_admin on public.coach_shifts;
create policy shifts_read_own_admin on public.coach_shifts for select to authenticated using(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin()));
drop policy if exists shifts_insert_own on public.coach_shifts;
create policy shifts_insert_own on public.coach_shifts for insert to authenticated with check(institution_id=public.current_institution_id() and coach_id=auth.uid() and public.current_app_role()='coach');
drop policy if exists shifts_update_own_admin on public.coach_shifts;
create policy shifts_update_own_admin on public.coach_shifts for update to authenticated using(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin())) with check(institution_id=public.current_institution_id() and (coach_id=auth.uid() or public.is_institution_admin()));

-- == Student policies (preserved) ==
drop policy if exists students_read on public.students;
create policy students_read on public.students for select to authenticated using(institution_id=public.current_institution_id());
drop policy if exists students_admin_write on public.students;
create policy students_admin_write on public.students for all to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and (class_id is null or exists(select 1 from public.classes c where c.id=class_id and c.institution_id=institution_id)));

-- == Medical policies (preserved) ==
drop policy if exists medical_admin_read on public.student_medical_records;
create policy medical_admin_read on public.student_medical_records for select to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin());
drop policy if exists medical_admin_insert on public.student_medical_records;
create policy medical_admin_insert on public.student_medical_records for insert to authenticated with check(institution_id=public.current_institution_id() and public.is_institution_admin() and created_by=auth.uid() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));
drop policy if exists medical_admin_update on public.student_medical_records;
create policy medical_admin_update on public.student_medical_records for update to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));
drop policy if exists medical_admin_delete on public.student_medical_records;
create policy medical_admin_delete on public.student_medical_records for delete to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin());

-- == Notices policies (preserved) ==
drop policy if exists notices_read on public.admin_notices;
create policy notices_read on public.admin_notices for select to authenticated using(institution_id=public.current_institution_id() and (is_published or public.is_institution_admin()));
drop policy if exists notices_admin_write on public.admin_notices;
create policy notices_admin_write on public.admin_notices for all to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and author_id=auth.uid());

-- == Conversations policies (preserved) ==
drop policy if exists conversations_read_member on public.conversations;
create policy conversations_read_member on public.conversations for select to authenticated using(institution_id=public.current_institution_id() and public.is_conversation_member(id));
drop policy if exists conversation_members_read on public.conversation_members;
create policy conversation_members_read on public.conversation_members for select to authenticated using(
 exists(select 1 from public.conversations c where c.id=conversation_id and c.institution_id=public.current_institution_id())
 and (public.is_conversation_member(conversation_id) or public.is_institution_admin())
);

-- == Student Notes policies (preserved) ==
drop policy if exists student_notes_read_shared on public.student_notes;
create policy student_notes_read_shared on public.student_notes for select to authenticated using(institution_id=public.current_institution_id() and (author_id=auth.uid() or public.is_institution_admin() or note_type<>'health_permission'));
drop policy if exists student_notes_insert_self on public.student_notes;
create policy student_notes_insert_self on public.student_notes for insert to authenticated with check(institution_id=public.current_institution_id() and author_id=auth.uid() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));
drop policy if exists student_notes_update_self_admin on public.student_notes;
create policy student_notes_update_self_admin on public.student_notes for update to authenticated using(institution_id=public.current_institution_id() and (author_id=auth.uid() or public.is_institution_admin())) with check(institution_id=public.current_institution_id() and exists(select 1 from public.students s where s.id=student_id and s.institution_id=institution_id));

-- == Admin Notices insert policy (preserved) ==
drop policy if exists notices_admin_write on public.admin_notices;
create policy notices_admin_write on public.admin_notices for all to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin()) with check(institution_id=public.current_institution_id() and public.is_institution_admin() and author_id=auth.uid());

-- == Ensure session_key column exists (additive) ==
alter table public.attendance_records add column if not exists session_key text not null default 'unspecified';

create unique index if not exists attendance_records_session_unique on public.attendance_records(student_id,session_date,session_key);

create index if not exists attendance_date_idx on public.attendance_records(institution_id,session_date desc);

-- Identity and authorization helpers. SECURITY DEFINER functions have fixed search_path.
create or replace function public.notify_new_notice() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
 insert into public.notifications(institution_id,recipient_id,title,body,notification_type)
 select new.institution_id,p.id,new.title,new.body,'notice'
 from public.profiles p where p.institution_id=new.institution_id and p.account_status='active' and p.id<>new.author_id;
 return new;
end $$;
drop trigger if exists admin_notice_notify on public.admin_notices;
create trigger admin_notice_notify after insert on public.admin_notices for each row when (new.is_published=true) execute function public.notify_new_notice();

create or replace function public.notify_submitted_report() returns trigger language plpgsql security definer set search_path=public,pg_temp
as $ begin
  if (TG_OP = 'INSERT' and new.is_finalized = true)
     or (TG_OP = 'UPDATE' and new.is_finalized = true
         and coalesce(old.is_finalized, false) = false) then
    insert into public.notifications(institution_id,recipient_id,title,body,notification_type)
    select new.institution_id,p.id,'Daily report submitted',new.coach_name_snapshot||' submitted a report for '||new.report_date::text,'report'
    from public.profiles p where p.institution_id=new.institution_id and p.account_status='active' and p.role in ('manager','admin');
  end if;
  return new;
end $;
drop trigger if exists daily_report_notify on public.daily_reports;
create trigger daily_report_notify after insert or update on public.daily_reports for each row when (new.is_finalized=true) execute function public.notify_submitted_report();

-- Tell every other conversation member about a new message.
create or replace function public.notify_new_message() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare v_name text; v_preview text; begin
 select coalesce(nullif(p.full_name,''),p.email) into v_name from public.profiles p where p.id=new.sender_id;
 v_preview:=left(coalesce(nullif(trim(new.body),''),'[attachment]'),160);
 insert into public.notifications(institution_id,recipient_id,title,body,notification_type)
 select new.institution_id,cm.profile_id,'رسالة جديدة',coalesce(v_name,'')||': '||v_preview,'message'
 from public.conversation_members cm
 join public.profiles p on p.id=cm.profile_id and p.account_status='active'
 where cm.conversation_id=new.conversation_id and cm.profile_id<>new.sender_id;
 return new;
end $$;
drop trigger if exists message_notify on public.messages;
create trigger message_notify after insert on public.messages for each row execute function public.notify_new_message();

-- == Messaging tables (additive completion of the documented schema) ==
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  title text,
  conversation_type text not null default 'direct' check (conversation_type in ('direct','group')),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists conversations_institution_idx on public.conversations(institution_id, created_at desc);

create table if not exists public.conversation_members (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (conversation_id, profile_id)
);
create index if not exists conversation_members_conversation_idx on public.conversation_members(conversation_id, profile_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  body text,
  message_type text not null default 'text' check (message_type in ('text','image','audio','file')),
  media_path text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table if not exists public.message_reads (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  unique (conversation_id, profile_id)
);

-- == Messaging read and insert policies: conversation membership required ==
drop policy if exists messages_read_member on public.messages;
create policy messages_read_member on public.messages for select to authenticated using(institution_id=public.current_institution_id() and public.is_conversation_member(conversation_id));
drop policy if exists messages_insert_member on public.messages for insert to authenticated with check(institution_id=public.current_institution_id() and public.is_conversation_member(conversation_id));

-- == Messaging read receipts and unread counts ==
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$ begin
  update public.messages m
     set read_at = now()
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and exists (
       select 1 from public.conversation_members cm
        where cm.conversation_id = m.conversation_id
          and cm.profile_id = auth.uid()
     );
end $$;

create or replace function public.unread_counts()
returns table (conversation_id uuid, unread bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.conversation_id, count(*)::bigint as unread
    from public.messages m
    join public.conversation_members cm
      on cm.conversation_id = m.conversation_id
     and cm.profile_id = auth.uid()
   where m.sender_id <> auth.uid()
     and m.read_at is null
   group by m.conversation_id;
$$;

-- == Attendance records table (additive) ==
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  coach_id uuid not null references public.profiles(id) on delete cascade,
  session_date date not null,
  status text not null default 'present',
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists attendance_records_inst_idx on public.attendance_records(institution_id, session_date);

-- == Absence follow-up tracking ==
create table if not exists public.absence_followups (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  streak_start date,
  streak_start_key text,
  streak_end date,
  streak_end_key text,
  absences int not null default 0,
  status text not null default 'none',
  last_follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists absence_followups_inst_status on public.absence_followups(institution_id, status);

create or replace function public.track_absence_followup() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$ begin
  return new;
end $$;

create or replace function public.mark_followup_handled(p_student_id uuid, p_status text default 'done')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$ begin
  update public.absence_followups
     set status = p_status,
         last_follow_up_at = now()
   where student_id = p_student_id;
end $$;

drop trigger if exists attendance_followup_trg on public.attendance_records;
create trigger attendance_followup_trg after insert or update of status on public.attendance_records for each row execute function public.track_absence_followup();

drop policy if exists absence_followups_admin_read on public.absence_followups;
create policy absence_followups_admin_read on public.absence_followups for select to authenticated using(institution_id=public.current_institution_id() and public.is_institution_admin());

-- == Private storage buckets for medical and conversation media ==
insert into storage.buckets (id, name, public) values
  ('trainer-avatars','trainer-avatars',false),
  ('trainer-media','trainer-media',false),
  ('trainer-medical','trainer-medical',false)
on conflict (id) do nothing;

drop policy if exists trainer_medical_admin_read on storage.objects;
create policy trainer_medical_admin_read on storage.objects for select to authenticated using (bucket_id = 'trainer-medical');

drop policy if exists trainer_media_read on storage.objects;
create policy trainer_media_read on storage.objects for select to authenticated using (
  bucket_id = 'trainer-media'
  and exists (
    select 1 from public.conversation_members m
    where m.profile_id = auth.uid()
      and public.is_conversation_member(m.conversation_id)
  )
);

commit;
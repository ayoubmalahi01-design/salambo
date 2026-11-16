# 03 — Schema mismatches (detailed)

Severity: P0 (blocks production) / P1 (basic function incomplete) / P2 (important) / P3 (improvement).

## P0

### M-1: `messages.read_at` column missing in live DB
- **SQL (THE_TRAINERS_SETUP.sql line 750):** `read_at timestamptz,` (nullable).
- **Live DB:** HTTP 400 "column messages.read_at does not exist".
- **App impact:** `mark_conversation_read` RPC (line 775) runs `update public.messages set read_at = now() where ...`. This will error at runtime when a user opens a conversation.
- **Fix (additive):** `ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at timestamptz;`
- **File:** `proposed_fixes_schema.sql` §1.

### M-2: `message_reads` schema differs from SQL (per-message vs per-conversation design)
- **SQL:** `id uuid PK, conversation_id uuid, profile_id uuid, last_read_at timestamptz not null default now(), unique(conversation_id, profile_id)`.
- **Live DB (probed):** has `read_at`, `message_id` (and `id` returns HTTP 400 — unconfirmed). Missing: `conversation_id, profile_id, last_read_at, updated_at, created_at`.
- **App impact:** `unread_counts()` and `mark_conversation_read()` RPCs are authored against the SQL design; if the live RPCs were created from this SQL, they will error against the live schema. Conversely, if the live RPCs were authored against the live schema, then the SQL file is wrong and must be updated to match.
- **Required action:** Read the live RPC definitions in the Dashboard (`pg_proc`) and reconcile. Do NOT run blind ALTERs on `message_reads` (could break the working RPCs). This is the highest-risk item.
- **Fix:** UNVERIFIED — manual reconciliation required. See `07_UNVERIFIED_AND_MANUAL_CHECKS.md`.

### M-3: Edge Functions not deployed
- All four functions (`invite-user`, `verify-otp`, `send-whatsapp`, `send-sms`) return 404.
- **App impact:** Account invitation, OTP verification, and internal WhatsApp/SMS delivery are entirely non-functional in production.
- **Fix:** Deploy the functions from `supabase/functions/`. No DB change required, but this is a deploy action requiring approval.

## P1

### M-4: `conversation_members.id` missing in live DB
- **SQL:** `id uuid primary key default gen_random_uuid()`.
- **Live DB:** MISSING (uses composite unique key on `(conversation_id, profile_id)`).
- **App impact:** None — app inserts without `id` and uses `on conflict do nothing`. Composite key exists in both.
- **Fix options:** (a) update SQL to drop `id` (match live), or (b) add `id` to live DB. Option (a) is safer and matches actual usage. Proposed as a comment-only note in `proposed_fixes_schema.sql` §2; not auto-applied because it changes a PK and could break FKs/RLS if anything references it (nothing does in the app, but cannot verify externally).

### M-5: Five tables missing from repository SQL (reproducibility gap)
Tables used by the app and present in live DB, but with NO `CREATE TABLE` in `THE_TRAINERS_SETUP.sql`, `INVITATIONS_OTP_INCREMENTAL.sql`, `THE_TRAINERS_INCREMENTAL_UPDATES.sql`, or any migration:
- `admin_notices` (app uses `author_id, title, body, institution_id, is_published, published_at`)
- `audit_logs` (app uses `institution_id, actor_id, action, table_name, record_id, old_data, new_data, created_at`)
- `coach_notebooks` (app uses `institution_id, coach_id, title, body, entry_date`)
- `notifications` (app uses `recipient_id, title, body, notification_type, read_at, created_at`)
- `student_notes` (app uses `institution_id, student_id, author_id, note_type, body, created_at, updated_at`)

**Impact:** A fresh project built from the repo SQL would lack these tables → app fails. Live DB has them (created manually or via an untracked path). No runtime impact on the current project, but a serious reproducibility/migration gap.
**Fix:** Add `CREATE TABLE IF NOT EXISTS` definitions for these 5 tables to `THE_TRAINERS_SETUP.sql` (additive). Proposed in `proposed_fixes_schema.sql` §3 (as documentation/additive SQL, not executed).

### M-6: `admin_notices.created_by` vs `author_id`
- Live DB has `author_id` (app uses `author_id`). SQL doesn't define the table. Not a mismatch with the app; only a naming inconsistency vs. other tables that use `created_by`. No action required.

## P2

### M-7: Storage buckets unverifiable
- `trainer-avatars`, `trainer-media`, `trainer-medical` return HTTP 400 for anon (list/metadata). Existence and policies cannot be confirmed via REST.
- App upload features (avatars, media, medical attachments, institution logos) depend on them.
- **Action required (manual):** verify buckets and policies in the Dashboard → Storage. Proposed policy templates in `proposed_fixes_rls_storage.sql`.

### M-8: RLS policies unverifiable
- `invitations`/`otp_codes` return 401 (RLS active there). Other tables return 200 empty — cannot distinguish "RLS allows anon SELECT" from "RLS disabled".
- The SQL defines RLS for all tables, but whether those policies are applied to the live DB is unknown.
- **Action required (manual):** `select * from pg_policies;` in the Dashboard SQL Editor.

### M-9: Auth configuration and triggers unverifiable
- `handle_new_auth_user` trigger on `auth.users`, `confirm_platform_owner`, email confirmation settings, and auth providers cannot be inspected via REST.
- **Action required (manual):** check Auth → Providers, Email templates, and `pg_trigger` for `on_auth_user_created` / `on_auth_user_confirmed`.

## P3

### M-10: `CREATE TABLE IF NOT EXISTS` does not repair drift
- Re-running `THE_TRAINERS_SETUP.sql` on the live DB will not add missing columns (e.g., `messages.read_at`). Only `ADD COLUMN IF NOT EXISTS` fixes drift. Proposed in `proposed_fixes_schema.sql`.

### M-11: `profiles.created_by` column
- SQL defines `created_by uuid references public.profiles(id)`. App does not reference it. Present in live DB (probe passed). No action.

## Items confirmed consistent (no mismatch)
- `institutions`: logo_path, email, phone, address, default_language, is_active, created_at, updated_at ✅ (SQL uses `email` and `logo_path`, not `contact_email`/`logo_url`).
- `profiles`: avatar_path, approved_by, approved_at, phone, preferred_language, account_status, role, institution_id ✅.
- `students`: class_id, student_code, date_of_birth, is_active ✅.
- `student_medical_records`: record_type, details, attachment_path, created_by ✅.
- `coach_shifts`: started_at, ended_at, notes ✅.
- `daily_reports`: all 21 columns including shift_start, shift_end, is_finalized, reviewed_by ✅.
- `conversations`, `conversation_members` (minus id), `notifications`, `admin_notices` (author_id/published_at), `audit_logs`, `coach_notebooks`, `student_notes`, `attendance_records`, `absence_followups`, `report_templates`, `report_exports` ✅.
- `invitations`, `otp_codes` exist (RLS-protected) ✅.

## Conclusion
Three P0 items (Edge Functions not deployed, `messages.read_at` missing, `message_reads` schema mismatch) must be resolved before production. The `message_reads`/RPC reconciliation is the highest-risk and requires manual inspection of live RPC definitions.

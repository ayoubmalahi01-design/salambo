# THE TRAINERS – تدريب — Supabase Audit Summary

**Audit date:** 2026-11-15
**Mode:** READ-ONLY (no SQL executed, no files modified, no deploys)
**Project directory:** `C:\Users\Admin\Documents\Default Project\tadrib-appjet-source\tadrib-appjet`
**Supabase project (confirmed):** `rxkyryaplszuklagvidi`
**Project URL:** `https://rxkyryaplszuklagvidi.supabase.co`
**Table Editor:** `https://supabase.com/dashboard/project/rxkyryaplszuklagvidi/editor/17668?schema=public`

## Verification of project folder
- `package.json`: name `the-trainers`, version `1.0.0`, private. Contains `src/`, `supabase/`, `scripts/`, `tests/`, `docs/`.
- `.env.local`: `VITE_SUPABASE_URL=https://rxkyryaplszuklagvidi.supabase.co` (matches confirmed project). NOT modified.
- The earlier-stated reference `ikrfxvxbqrmcnnzwrhsz` was a stale/incorrect reference; the correct and confirmed project is `rxkyryaplszuklagvidi`. See `SUPABASE_PROJECT_MISMATCH_AND_AUDIT_STATUS.md`.

## Audit method and limitations
- Only the **anon/publishable key** was used (read-only REST/PostgREST). No service_role key was used.
- The PostgREST OpenAPI root (`/rest/v1/`) requires a secret key on this project and returned 401, so the full schema was NOT auto-discovered; tables and columns were probed explicitly.
- **Cannot be verified via anon REST (documented, not guessed):** RLS policy definitions, function/RPC bodies, triggers, storage bucket metadata/policies, Auth configuration, Edge Function deployment list (probed via `/functions/v1/*` → 404), and column-level detail for RLS-protected tables (`invitations`, `otp_codes`).
- All findings below are based on actual REST responses (HTTP status + error messages) and on reading the repository's SQL/src files. No guessing.

## Top findings (priority)

### P0 — blocks production
1. **Edge Functions are NOT deployed.** All four (`invite-user`, `verify-otp`, `send-whatsapp`, `send-sms`) return `404 "Requested function was not found"`. The account invitation/OTP flow and internal message delivery depend on them → the invitation flow is broken in production.
2. **`messages.read_at` is missing in the live DB** (SQL defines it; live DB does not). The `mark_conversation_read` RPC updates `messages.read_at`, so marking a conversation as read will fail at runtime.
3. **`message_reads` schema mismatch.** SQL defines `id, conversation_id, profile_id, last_read_at`. Live DB has `read_at, message_id` (and `id` returns HTTP 400). The `unread_counts` / `mark_conversation_read` RPCs (built against the SQL design) likely fail against the live schema. UNVERIFIED (RPC bodies not readable via REST).

### P1 — basic function incomplete
4. **`conversation_members.id` missing in live DB** (SQL defines a UUID PK; live DB uses the composite unique key). Low runtime impact (app uses composite key + `on conflict`), but schema drift vs. SQL.
5. **Five tables used by the app are NOT defined in any repository SQL file**: `admin_notices`, `audit_logs`, `coach_notebooks`, `notifications`, `student_notes`. They exist in the live DB (HTTP 200) but a fresh project built from `THE_TRAINERS_SETUP.sql` would lack them. Reproducibility gap.
6. **Storage buckets unverifiable** via anon REST (all probes returned 400/empty). Cannot confirm `trainer-avatars`, `trainer-media`, `trainer-medical` exist or their policies. App upload features depend on them.
7. **RLS policies unverifiable** via anon REST. Tables return 200 with empty results for anon — cannot distinguish "RLS allows anon SELECT on empty table" from "RLS disabled". Must be checked in the Dashboard.

### P2 — important but not blocking
8. `invitations` and `otp_codes` exist (HTTP 401 = permission denied, not "relation does not exist") and are RLS-protected for anon. Good.
9. All 22 expected tables exist in the live DB. ✅
10. Column-level audit: 193 probes, 11 "missing" — of which 7 are **expected absences** (SQL does not define those columns: `classes.updated_at`, `coach_shifts.updated_at`, `student_medical_records.updated_at`, `institutions.contact_email` [SQL uses `email`], plus `conversation_members.id`/`messages.read_at`/`message_reads.*` which are real mismatches noted above). The remaining 4 are `conversation_members.id`, `messages.read_at`, `message_reads.*` (real), and `admin_notices.created_by` (app uses `author_id`, which exists — false positive).

### P3 — improvements
11. The SQL files use `CREATE TABLE IF NOT EXISTS` / `CREATE POLICY ... IF NOT EXISTS` patterns that do not correct schema drift on existing tables (e.g., a missing `read_at` column is never added by re-running the setup SQL). Proposed additive SQL is provided (not executed).
12. `auth.users` trigger (`handle_new_auth_user`) and `confirm_platform_owner` cannot be verified via REST. UNVERIFIED.

## Data state
- All 22 probed tables returned 0 rows (Content-Range `*/0`). The live database appears empty (no institutions, profiles, students, etc.). This is consistent with a fresh/unused project. No data was read or modified.

## Deliverables in this folder
- `00_AUDIT_SUMMARY.md` (this file)
- `01_LOCAL_PROJECT_DB_DEPENDENCIES.md`
- `02_LIVE_DB_TABLES_AND_COLUMNS.md`
- `03_SCHEMA_MISMATCHES.md`
- `04_RLS_SECURITY_AUTH_STORAGE.md`
- `05_EDGE_FUNCTIONS.md`
- `06_SQL_FILES_REVIEW.md`
- `07_UNVERIFIED_AND_MANUAL_CHECKS.md`
- `proposed_fixes_schema.sql` (additive, NOT executed)
- `proposed_fixes_rls_storage.sql` (template, NOT executed)
- `live_tables_probe.json`, `column_probe.json` (raw REST probe output)

## Required manual actions (cannot be done via REST)
1. Open the Dashboard SQL Editor and run read-only queries to capture: RLS policies (`pg_policies`), functions (`pg_proc`), triggers (`pg_trigger`), storage buckets (`storage.buckets`), storage policies, auth config, and edge function deployment list.
2. Deploy the 4 Edge Functions (`invite-user`, `verify-otp`, `send-whatsapp`, `send-sms`) — required for the invitation flow.
3. Reconcile `message_reads` schema vs. the RPCs (`unread_counts`, `mark_conversation_read`) before production.
4. Add the 5 missing-from-repo tables to `THE_TRAINERS_SETUP.sql` for reproducibility.
5. Apply `proposed_fixes_schema.sql` (additive) only after review.

No SQL was executed and no application files were modified during this audit.

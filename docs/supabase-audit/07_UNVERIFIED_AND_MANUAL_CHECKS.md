# 07 — Unverified items and required manual checks

Items that could NOT be verified via the anon REST key, with the exact manual steps needed.

## A. RLS policies
- **Why unverified:** anon REST cannot read `pg_policies`.
- **Manual check (Dashboard → SQL Editor):**
  ```sql
  select schemaname, tablename, policyname, cmd, qual, with_check
  from pg_policies where schemaname='public' order by tablename, policyname;
  select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r';
  ```
- **Compare against:** `THE_TRAINERS_SETUP.sql` policies (lines ~500–610) and `INVITATIONS_OTP_INCREMENTAL.sql`.
- **Expected:** all 22 tables have `relrowsecurity = true`; policy set matches SQL.

## B. Functions / RPCs
- **Why unverified:** anon REST cannot read `pg_proc` bodies.
- **Manual check:**
  ```sql
  select p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' order by p.proname;
  ```
- **Critical:** read `unread_counts()` and `mark_conversation_read()` definitions and confirm they match the live `message_reads` schema (`read_at, message_id`). Reconcile with `proposed_fixes_schema.sql`.
- Also verify: `my_profile`, `current_institution_id`, `current_app_role`, `is_platform_owner`, `is_institution_admin`, `is_active_member`, `is_conversation_member`, `create_conversation`, `ensure_my_profile`, `review_account`, `sync_missing_profiles`, `handle_new_auth_user`, `confirm_platform_owner`, `write_audit_log`, `guard_profile_privileges`, `guard_conversation_member_relation`, `set_updated_at`.

## C. Triggers
- **Manual check:**
  ```sql
  select tgname, tgrelid::regclass, pg_get_functiondef(tgfoid) from pg_trigger where not tgisinternal;
  ```
- **Expected:** `on_auth_user_created`, `on_auth_user_confirmed`, `profiles_privilege_guard`, `profiles_audit`, `profiles_set_updated_at`, `conversation_member_relation_guard`, plus audit triggers on `report_templates`/`report_exports`.

## D. Storage buckets and policies
- **Manual check (Dashboard → Storage):** confirm buckets `trainer-avatars`, `trainer-media`, `trainer-medical` exist with correct public/private settings, size limits, MIME types, and policies.
- **SQL check:**
  ```sql
  select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;
  select * from pg_policies where schemaname='storage';
  ```

## E. Auth configuration
- **Manual check (Dashboard → Authentication → Providers/Email):** email/password enabled, email confirmation enabled, no unexpected providers.
- **Manual check:** `select * from auth.users limit 5;` (in SQL Editor, service role) to confirm the owner row and any orphan profiles.

## F. Edge Function deployment
- **Confirmed (via REST):** all 4 functions return 404 → NOT deployed.
- **Required action:** deploy + set secrets (see `05_EDGE_FUNCTIONS.md`).

## G. Data verification
- All 22 tables returned 0 rows (Content-Range `*/0`). Confirm in Dashboard that this is intended (fresh project) and that no data was lost.

## H. Reproducibility
- Add the 5 missing-from-SQL tables (`admin_notices`, `audit_logs`, `coach_notebooks`, `notifications`, `student_notes`) to `THE_TRAINERS_SETUP.sql` (proposed in `proposed_fixes_schema.sql` §3).

## I. `message_reads` reconciliation (highest risk)
- Read the live `unread_counts()` and `mark_conversation_read()` definitions (see §B) and decide:
  - Option A: alter live `message_reads` to match SQL (add `conversation_id, profile_id, last_read_at`; migrate data from `read_at`/`message_id` if any — but table is empty, so safe). Then recreate RPCs from SQL.
  - Option B: update SQL + RPCs to match the live design (per-message receipts). Requires code changes in `src/App.tsx` (`unread_counts` RPC call) and tests.
- Table is empty → either option is safe data-wise. Choose based on the intended unread-count semantics (per-conversation last-read vs per-message).

## J. `conversation_members.id`
- Either remove `id` from SQL (match live composite PK) or add `id` to live DB. Recommend removing from SQL (nothing references it). Low risk either way.

## K. `messages.read_at`
- Additive fix: `ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at timestamptz;` (proposed in `proposed_fixes_schema.sql` §1). Safe because the column is nullable and the table is empty.

No SQL was executed during this audit. All proposed fixes are in `proposed_fixes_schema.sql` and `proposed_fixes_rls_storage.sql` (not applied).

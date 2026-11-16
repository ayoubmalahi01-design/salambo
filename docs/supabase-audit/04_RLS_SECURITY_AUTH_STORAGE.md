# 04 — RLS, security, Auth, and Storage

## 4.1 RLS policies (UNVERIFIED via REST)
- Anon REST cannot read `pg_policies`. The Dashboard SQL Editor is required: `select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public';`
- Behavioral evidence:
  - `invitations` and `otp_codes`: HTTP 401 "permission denied for table" → RLS is active and denies anon. ✅ (desired)
  - All other 20 tables: HTTP 200 with empty results for anon. This is ambiguous — either RLS allows anon SELECT (and tables are empty) or RLS is disabled. Cannot distinguish without reading policies.
- The SQL file defines RLS for all tables (SELECT/INSERT/UPDATE/DELETE policies scoped by institution and role). Whether these are applied to the live DB is UNVERIFIED.
- **Required manual check:** confirm `pg_tables.rowsecurity = true` for all 22 tables and that the policy set matches `THE_TRAINERS_SETUP.sql` (lines ~500–610).

## 4.2 Authorization model (from SQL + app)
- Roles: `owner`, `manager`, `admin`, `coach` (enum `app_role`).
- Account review: only `owner` and `manager` (via `review_account` RPC). `admin` and `coach` cannot invite/approve/reject. Enforced in `account-policy.ts` (client) AND in the RPC (server).
- Institution isolation: `current_institution_id()` and `is_active_member()` helpers. All data tables are scoped by `institution_id`.
- Coach privacy: coaches see only their own reports/notebooks; messages only within conversations they belong to.
- Self-promotion guard: `guard_profile_privileges` trigger prevents role/institution self-change. Verified in tests (`0003_account_management_repair.sql`).
- Owner bootstrap: hardcoded email `ayoubmalleh772@gmail.com`; owner role assigned only on confirmed email; only one owner allowed.

## 4.3 Auth (UNVERIFIED via REST)
- Cannot inspect Auth settings, providers, email templates, or `auth.users` triggers via anon REST.
- **Required manual checks in Dashboard → Authentication:**
  - Email confirmation enabled (required for owner bootstrap).
  - Auth providers (email/password expected).
  - Trigger `on_auth_user_created` on `auth.users` exists and calls `handle_new_auth_user`.
  - Trigger `on_auth_user_confirmed` exists and calls `confirm_platform_owner`.
  - No service_role key in frontend (confirmed: `.env.local` uses publishable key only; `grep` shows no service_role in src).

## 4.4 Storage (UNVERIFIED via REST)
- Anon cannot list buckets or read bucket metadata (HTTP 400/empty). App references buckets: `trainer-avatars`, `trainer-media`, `trainer-medical`.
- **Required manual checks in Dashboard → Storage:**
  - Buckets exist with correct public/private settings.
  - File size limits and allowed MIME types (PNG/JPEG/WebP for avatars; images/audio/PDF for media).
  - Storage policies: users can upload/read only their own institution's files; avatars readable by authenticated institution members.
  - Paths used by app: `${institution_id}/${user_id}/avatar-...`, `${institution_id}/${conversation_id}/${user_id}/...`, institution logos under `${institution_id}/${user_id}/institution-logo-...`.

## 4.5 Data privacy observations
- `audit_logs` stores `old_data`/`new_data` as JSONB with file paths redacted (per `write_audit_log`).
- `report_templates.file_path` and `report_exports.file_path` are redacted in audit logs.
- No secrets (service_role, DB password) found in frontend source or `.env.example`.

## 4.6 Security risks identified
- **R-1 (P0):** Edge Functions not deployed → invitation flow non-functional (see `05_EDGE_FUNCTIONS.md`).
- **R-2 (P0):** `messages.read_at` missing → `mark_conversation_read` RPC fails.
- **R-3 (P0):** `message_reads` schema mismatch → unread-count RPCs likely fail.
- **R-4 (P1):** RLS policies unverified → cannot confirm institution isolation is enforced in production.
- **R-5 (P1):** Storage buckets/policies unverified → cannot confirm file access control.
- **R-6 (P2):** `handle_new_auth_user` hardcoded owner email — if the owner email changes, the SQL must be updated and re-run.

No evidence of secrets in the frontend. No SQL was executed.

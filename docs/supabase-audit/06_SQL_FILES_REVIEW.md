# 06 — SQL files review (THE_TRAINERS_SETUP.sql, INVITATIONS_OTP_INCREMENTAL.sql, THE_TRAINERS_INCREMENTAL_UPDATES.sql, migrations/*)

## Files reviewed
- `supabase/THE_TRAINERS_SETUP.sql` (~60 KB) — full fresh-project schema.
- `supabase/INVITATIONS_OTP_INCREMENTAL.sql` (~60 KB) — invitations + OTP (additive).
- `supabase/THE_TRAINERS_INCREMENTAL_UPDATES.sql` (~13 KB) — report_templates + report_exports (additive).
- `supabase/migrations/0001_attendance_session_dimension.sql`
- `supabase/migrations/0002_report_draft_submit_notify.sql`
- `supabase/migrations/0003_account_management_repair.sql` (~31 KB)

## Findings

### Strengths
- All DDL uses `IF NOT EXISTS` / `CREATE OR REPLACE` → idempotent re-runs are safe (no data loss).
- Transactional (`begin; ... commit;` in setup).
- RLS enabled on all tables with scoped policies (institution + role).
- SECURITY DEFINER helpers with fixed `search_path` (prevents search_path injection).
- Privilege guard trigger prevents self-promotion.
- Audit logging on sensitive tables.
- No `DROP TABLE`, `TRUNCATE`, or `DELETE` in setup/migrations (only `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS` for idempotency).
- `INVITATIONS_OTP_INCREMENTAL.sql` hashes OTPs (pgcrypto), uses `SELECT ... FOR UPDATE`, and prevents auto-activation.

### Risks / gaps
1. **`CREATE TABLE IF NOT EXISTS` does not repair drift.** A missing column (e.g., `messages.read_at`) is never added by re-running the setup SQL. Only `ADD COLUMN IF NOT EXISTS` fixes it. → `proposed_fixes_schema.sql`.
2. **5 tables used by the app are not defined in any repo SQL** (`admin_notices`, `audit_logs`, `coach_notebooks`, `notifications`, `student_notes`). They exist in the live DB (created outside version control). A fresh project from this SQL would lack them. → Add their DDL to `THE_TRAINERS_SETUP.sql` (proposed in `proposed_fixes_schema.sql` §3).
3. **`message_reads` schema drift** between SQL and live DB. The SQL assumes `conversation_id, profile_id, last_read_at`; live DB has `read_at, message_id`. The RPCs are authored against the SQL design. Must reconcile manually (read live `pg_proc`). → `07_UNVERIFIED_AND_MANUAL_CHECKS.md`.
4. **`conversation_members.id`** exists in SQL (UUID PK) but not in live DB (composite PK). The app works with the composite key. Either remove `id` from SQL or add it to live DB; recommend updating SQL to match live (composite PK) since nothing references `id`.
5. **Owner bootstrap email hardcoded** (`ayoubmalleh772@gmail.com`) in `handle_new_auth_user` and `confirm_platform_owner`. If the owner email changes, the SQL must be updated and re-run.
6. **Storage bucket creation is not in SQL.** Buckets (`trainer-avatars`, `trainer-media`, `trainer-medical`) must be created manually in the Dashboard (or via a migration). The SQL only defines storage *policies* (assuming buckets exist).
7. **Edge Functions are not deployed** (see `05_EDGE_FUNCTIONS.md`).
8. **Migrations ordering:** `0003` depends on tables/functions from the setup SQL. Must run setup first, then migrations in order. Documented but not enforced by tooling.

### Idempotency assessment
- Safe to re-run on an existing DB: setup SQL (no data loss), incremental SQLs (IF NOT EXISTS), migrations (0003 is transactional and additive).
- NOT sufficient to repair drift: missing columns will remain missing.

### Conclusion
The SQL files are well-structured, additive, and non-destructive. The main gap is **schema drift between SQL and live DB** (missing `read_at`, `conversation_members.id`, `message_reads` redesign) plus **missing table definitions** for 5 app-used tables. Proposed additive fixes are in `proposed_fixes_schema.sql` (not executed).

# 01 — Local project database dependencies (from src + SQL)

Source of truth: `src/App.tsx` (single-file app), `src/lib/*.ts`, `supabase/*.sql`, `supabase/migrations/*.sql`, `supabase/functions/*`.

## Tables referenced by the application (22)
From `src/App.tsx` (`supabase.from('...')`) plus SQL-defined tables:
`absence_followups, admin_notices, attendance_records, audit_logs, classes, coach_notebooks, coach_shifts, conversation_members, conversations, daily_reports, institutions, invitations, messages, message_reads, notifications, otp_codes, profiles, report_exports, report_templates, student_medical_records, student_notes, students`

Storage buckets referenced by the app: `trainer-avatars`, `trainer-media`, `trainer-medical` (used in `supabase.storage.from(...)`).

Edge functions referenced by the app: `invite-user`, `verify-otp` (via `supabase.functions.invoke`). Internal delivery: `send-whatsapp`, `send-sms` (called by invite-user with `x-internal-secret`).

RPCs referenced by the app: `ensure_my_profile`, `review_account`, `sync_missing_profiles`, `create_conversation`, `mark_conversation_read`, `unread_counts`, `mark_conversation_read`.

## Key application ↔ DB contracts
- `profiles.avatar_path` (nullable text) — avatar storage path.
- `institutions.logo_path` (nullable text) — institution logo storage path.
- `messages` has no `read_at` usage in app (uses RPC), but SQL defines `read_at` and `mark_conversation_read` updates it.
- `conversation_members` composite key `(conversation_id, profile_id)`; app inserts without `id`.
- `daily_reports` status flow: draft → submitted → reviewed.
- `report_templates` / `report_exports` exist in SQL but have NO frontend UI (no template management, no export logging). The client-side Word export (added in Phase 2) generates a `.docx` without touching these tables.

## Auth / account flow
- `handle_new_auth_user` trigger on `auth.users` creates a `profiles` row (owner email → owner/active; else coach/pending).
- `confirm_platform_owner` activates the owner on email confirmation.
- Account review via `review_account` RPC (owner/director only).
- Invite flow via `invite-user` edge function + OTP via `verify-otp`.

## Migrations (3)
- `0001_attendance_session_dimension.sql`
- `0002_report_draft_submit_notify.sql`
- `0003_account_management_repair.sql` (adds account RPCs, privilege guard, RLS repair, patches legacy OTP auto-activation)

## Conclusion
The application's DB contract is fully documented in the SQL files and `src/App.tsx`. Any table/column/RPC/bucket/function the app references is listed above and was probed against the live DB (see `02_LIVE_DB_TABLES_AND_COLUMNS.md`).

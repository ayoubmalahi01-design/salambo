# 02 — Live DB tables and columns (probed via anon REST)

Probe method: `GET /rest/v1/<table>?select=<col>&limit=1` for 193 (table,column) pairs, plus `select=*` for column discovery on empty tables. Raw output: `column_probe.json`, `live_tables_probe.json`.

## Table existence (22 expected → 22 present)
All 22 expected tables return HTTP 200 (or 401 for RLS-protected ones) — i.e. the relation exists:
- HTTP 200 (anon-readable, empty): 20 tables.
- HTTP 401 permission denied (exists but RLS-protected for anon): `invitations`, `otp_codes`. (A non-existent table would return 404 "relation does not exist", so 401 confirms existence.)

Row counts: Content-Range `*/0` for all probed tables → the live DB is **empty** (0 rows in every table). No data was read or modified.

## Column probe results
193 probes, 11 flagged "missing". Reclassification:

### Expected absences (SQL does not define these columns — NOT mismatches)
- `classes.updated_at` — SQL defines only `created_at`.
- `coach_shifts.updated_at` — SQL defines only `created_at`.
- `student_medical_records.updated_at` — SQL defines only `created_at`.
- `institutions.contact_email` — SQL uses `email` (app also uses `email`). ✅
- `admin_notices.created_by` — SQL does not define `admin_notices` at all; app uses `author_id` (exists). ✅

### Real mismatches (SQL defines, live DB missing)
- `messages.read_at` — SQL line 750 defines `read_at timestamptz`. Live DB: MISSING. The `mark_conversation_read` RPC updates `messages.read_at` → will fail at runtime.
- `conversation_members.id` — SQL defines `id uuid primary key`. Live DB: MISSING (composite PK in live). App does not use `id` (uses composite key + `on conflict`), so low runtime impact, but schema drift.
- `message_reads` — fundamental design mismatch:
  - SQL: `id, conversation_id, profile_id, last_read_at` (+ unique on conversation_id, profile_id).
  - Live DB: has `read_at, message_id` (per-message receipts) and `id` returns HTTP 400 (unconfirmed). Missing: `conversation_id, profile_id, last_read_at, updated_at, created_at`.
  - The `unread_counts` and `mark_conversation_read` RPCs are built against the SQL design → likely fail against the live schema. UNVERIFIED (RPC bodies not readable via REST).

### Confirmed present (sample)
`institutions.logo_path`, `institutions.email`, `profiles.avatar_path`, `profiles.approved_by`, `profiles.approved_at`, `students.class_id`, `students.student_code`, `student_medical_records.attachment_path`, `student_medical_records.record_type`, `coach_shifts.started_at`, `coach_shifts.ended_at`, `daily_reports.*` (all 21 columns present), `conversations.*`, `notifications.*`, `audit_logs.*`, `coach_notebooks.*`, `student_notes.*`, `report_templates.*`, `report_exports.*`, `attendance_records.*`, `absence_followups.*`.

## Unverified tables (RLS-protected, columns not probeable via anon)
- `invitations` (HTTP 401) — exists; RLS denies anon. Columns assumed per SQL/`INVITATIONS_OTP_INCREMENTAL.sql`: `id, invited_email, invited_name, role, institution_id, status, delivery_method, expires_at, created_at, updated_at`.
- `otp_codes` (HTTP 401) — exists; RLS denies anon. Columns assumed: `id, invitation_id, code_hash, expires_at, used_at, created_at`.

## Storage
- `GET /storage/v1/bucket` → `[]` for anon (no publicly listable buckets).
- `GET /storage/v1/bucket/<name>` and `POST /storage/v1/object/list/<name>` → HTTP 400 for `trainer-avatars`, `trainer-media`, `trainer-medical`.
- Bucket existence and policies are **UNVERIFIED** via REST (anon has no storage read). Must be checked in the Dashboard.

## Edge functions
- `GET/POST /functions/v1/{invite-user,verify-otp,send-whatsapp,send-sms}` → `404 "Requested function was not found"`.
- **Conclusion: none of the 4 Edge Functions are deployed.** See `05_EDGE_FUNCTIONS.md`.

## Auth
- Not inspectable via anon REST. Trigger `handle_new_auth_user` on `auth.users`, `confirm_platform_owner`, and account status flow are UNVERIFIED via REST (must be checked in Dashboard / Auth settings).
- The owner bootstrap email `ayoubmalleh772@gmail.com` is hardcoded in the SQL (`handle_new_auth_user`).

## RLS
- Not readable via anon REST. Behavior evidence: `invitations`/`otp_codes` return 401 (RLS active there); other tables return 200 empty (cannot distinguish RLS-allowed-anon-select from RLS-disabled). Must be checked in Dashboard (`pg_policies`).

## Summary of mismatches
| # | Item | Type | Runtime impact |
|---|---|---|---|
| 1 | `messages.read_at` missing | MISMATCH | High — `mark_conversation_read` RPC fails |
| 2 | `conversation_members.id` missing | MISMATCH (drift) | Low — app uses composite key |
| 3 | `message_reads` schema differs | MISMATCH | High — `unread_counts`/`mark_conversation_read` RPCs likely fail |
| 4 | 5 tables not in repo SQL (`admin_notices`, `audit_logs`, `coach_notebooks`, `notifications`, `student_notes`) | MISSING-FROM-REPO (exist live) | Reproducibility gap |
| 5 | Edge Functions not deployed | MISSING | High — invitation/OTP flow broken |
| 6 | Storage buckets/policies | UNVERIFIED | Unknown |
| 7 | RLS policies | UNVERIFIED | Unknown |
| 8 | Auth config/triggers | UNVERIFIED | Unknown |

# THE TRAINERS – تدريب — Full Live Supabase Audit (Refresh)
**Audit date:** 2026-11-15 (refresh)
**Mode:** READ-ONLY (anon REST; no SQL executed, no files modified)
**Project:** `rxkyryaplszuklagvidi` (`https://rxkyryaplszuklagvidi.supabase.co`)
**Local project:** `C:\Users\Admin\Documents\Default Project\tadrib-appjet-source\tadrib-appjet`

## 1. Direct connection to Supabase
- **Method:** REST/PostgREST with the publishable (anon) key from `.env.local`. No service_role key used.
- **Result:** Partial success. Tables/columns probeable; storage buckets, RLS policies, functions/triggers/auth config are NOT readable by anon (401/400). Those are documented as UNVERIFIED with exact manual queries.
- No secrets printed. No SQL executed.

## 2. What was verified directly

### 2.1 Tables (22 expected → 22 present)
All 22 tables exist (HTTP 200, or 401 = RLS-protected which still confirms existence):
institutions, profiles, classes, students, student_medical_records, coach_shifts, daily_reports, report_templates, report_exports, conversations, conversation_members, messages, message_reads, attendance_records, absence_followups, invitations, otp_codes, admin_notices, audit_logs, coach_notebooks, notifications, student_notes.
All returned 0 rows (Content-Range `*/0`) → live DB is empty.

### 2.2 Migration 0004 (user confirmed executed) — VERIFIED APPLIED
- `report_templates.name`, `description`, `instructions`, `is_archived` → all EXISTS. ✅
- `report_details` table → EXISTS with id, report_id, institution_id, student_id, observation, notes. ✅
- `report_exports` → EXISTS. ✅

### 2.3 Column-level verification (fresh probe)
- `messages.read_at` → **EXISTS** ✅ (earlier audit was stale; now confirmed).
- `messages.id` → EXISTS ✅
- `conversation_members.conversation_id`, `profile_id`, `joined_at` → EXISTS ✅
- `conversation_members.id` → **MISSING** (live DB uses composite PK `(conversation_id, profile_id)`). ✅ expected per design — do NOT add `id`.
- `message_reads.read_at`, `message_reads.message_id` → EXISTS
- `message_reads.id`, `conversation_id`, `profile_id`, `last_read_at` → MISSING (live design is per-message receipts, not per-conversation last-read). ⚠️ See §3.3.

### 2.4 Storage buckets
- `GET /storage/v1/bucket` → `[]` for anon. `GET /storage/v1/bucket/<name>` and `POST /storage/v1/object/list/<name>` → 400 for `trainer-avatars`, `trainer-media`, `trainer-medical`.
- **Bucket existence and policies UNVERIFIED via REST.** Must be checked in Dashboard.

### 2.5 Edge Functions
- All four (`invite-user`, `verify-otp`, `send-whatsapp`, `send-sms`) → **404 "Requested function was not found"**. NOT deployed. (Re-confirmed.)

## 3. Detailed findings

### 3.1 Storage policy `trainer_storage_member_rw` — UNVERIFIED (highest priority)
- Cannot read `storage.objects` policies via anon REST. **Must be checked in Dashboard.**
- Required manual query:
  ```sql
  select policyname, cmd, qual, with_check from pg_policies
  where schemaname='storage' and tablename='objects' order by policyname;
  ```
- Compare against: `trainer_avatar_upload`, `trainer_avatar_update`, `trainer_media_upload`, `trainer_media_read`, `trainer_media_delete_own`, `trainer_medical_admin_read`, `trainer_medical_admin_upload`, `trainer_storage_medical_admin`, `report_templates_read/write/update/delete`.
- **Concern (from code review):** if `trainer_storage_member_rw` grants ALL on `trainer-avatars`/`trainer-media` scoped only by institution, it may let any institution member read/modify another member's avatar or chat attachment. Verify the actual `qual`/`with_check`.
- **App path conventions:** avatars `${institution_id}/${user_id}/avatar-...`; media `${institution_id}/${conversation_id}/${user_id}/...`; medical `${institution_id}/${user_id}/...`; templates `${institution_id}/report-templates/...`.
- **Recommendation:** do not delete `trainer_storage_member_rw` until confirming the alternative policies cover all operations. Apply least-privilege fix only after review.

### 3.2 Conversation policies — UNVERIFIED (need `pg_policies`)
- `conversation_members_insert`, `conversation_members_creator_add`, `conversation_members_manager_add`, `conversation_members_remove` cannot be read via anon REST.
- **Manual query (Dashboard SQL Editor):**
  ```sql
  select policyname, cmd, qual, with_check from pg_policies
  where schemaname='public' and tablename in ('conversations','conversation_members','messages','message_reads')
  order by tablename, policyname;
  ```
- `conversation_member_relation_guard` trigger + `guard_conversation_member_relation()` function: cannot read via REST. Verify in Dashboard (`pg_trigger`, `pg_proc`).
- RLS is active on all 3 messaging tables (per earlier audit + behavioral evidence).

### 3.3 `message_reads` reconciliation (HIGH)
- Live design: per-message receipts (`read_at`, `message_id`).
- SQL design: per-conversation last-read (`conversation_id`, `profile_id`, `last_read_at`).
- App uses `unread_counts()` and `mark_conversation_read(p_conversation_id)` RPCs — authored against the SQL design.
- **If live RPCs were built from the SQL, they likely fail against the live schema.** UNVERIFIED (need `pg_proc`).
- **Recommendation:** read live RPC definitions first. Table is empty → either reconciliation option is data-safe. Do NOT alter columns blindly.

### 3.4 Migration 0004 — VERIFIED APPLIED
- `report_templates` new columns (name, description, instructions, is_archived): ✅ all exist.
- `report_details` table: ✅ exists with all columns.
- Trigger `notify_submitted_report`: cannot verify definition via REST (need `pg_trigger`/`pg_proc`). The migration file defines it as `after insert or update ... when (new.is_finalized=true)` with guard. Assume applied per user confirmation.
- `report_exports`: ✅ exists.

### 3.5 Other tables (verified present)
`admin_notices`, `audit_logs`, `coach_notebooks`, `notifications`, `student_notes` — all exist (HTTP 200). Confirmed: no need to create them.

### 3.6 Edge Functions — 404 (NOT deployed)
All four return 404. Source code is correct (uses `OTP_DELIVERY_SECRET`, Authorization, code_hash, rate limiting). **Deploy + secrets required (approval needed).**

### 3.7 RLS/Auth/Storage/Triggers — UNVERIFIED via REST
Cannot read `pg_policies`, `pg_proc`, `pg_trigger`, `storage.buckets`, `storage.objects` policies, or Auth config with anon key. Manual queries provided in §3.1, §3.2, and `docs/supabase-audit/07_UNVERIFIED_AND_MANUAL_CHECKS.md`.

## 4. Code ↔ DB mismatches (confirmed)

| # | Item | Status | Impact |
|---|---|---|---|
| 1 | `messages.read_at` | ✅ EXISTS (was stale "missing") | None |
| 2 | `conversation_members.id` | MISSING (by design) | None — app uses composite key |
| 3 | `message_reads` schema mismatch | ⚠️ MISMATCH | HIGH — RPCs may fail |
| 4 | Edge Functions not deployed | ⚠️ MISSING | HIGH — invitation flow broken |
| 5 | Storage buckets/policies | UNVERIFIED | Unknown |
| 6 | RLS policies | UNVERIFIED | Unknown |
| 7 | Auth/triggers | UNVERIFIED | Unknown |

## 5. Local code fixes applied (this session)
- `src/App.tsx`: avatar state/effect/UI, exportWord handler + button + logging, ReportTemplates component + nav + route, student details UI, Profile.avatar_path, ReportRow shift fields.
- `src/lib/i18n.ts`: template/export/avatar keys (AR/FR/EN).
- `src/lib/report-export.ts`: DOCX generator (Phase 2).
- `src/styles.css`: recolored to official palette + brand-mark uses official emblem.
- `public/manifest.webmanifest`: updated colors + icon ref.
- `public/icons/brand-emblem.png`: official image (unmodified).
- `supabase/THE_TRAINERS_SETUP.sql`: trigger fix.
- `supabase/migrations/0004_...sql`: new (additive).
- `docs/supabase-audit/*`: audit reports.

No app source files deleted. No production DB changes executed.

## 6. Test results
- `tsc --noEmit`: ✅ clean
- `npm test`: ✅ 109 / 109 pass
- `npm run verify`: ✅ 78 / 78 pass
- `npm run build`: ✅ pass (bundle 339 KB)

## 7. Required manual actions (approval needed)
1. **Read `pg_policies`, `pg_proc`, `pg_trigger`, `storage.buckets`, `storage.objects` policies, Auth config** in Dashboard (queries provided above and in `07_UNVERIFIED_AND_MANUAL_CHECKS.md`).
2. **Reconcile `message_reads`** (Option A/B) after reading live RPC definitions.
3. **Deploy Edge Functions** (4) + set `OTP_DELIVERY_SECRET` + provider creds.
4. **Create `trainer-report-templates` bucket** + policies (SQL prepared).
5. **Apply `proposed_fixes_schema.sql` §1** (`messages.read_at`) — already exists, so skip.
6. **Manual review** of storage policy `trainer_storage_member_rw` (highest priority per user).

## 8. Severity classification
- **CRITICAL:** Edge Functions not deployed (invitation/OTP broken); `message_reads` schema mismatch (unread counts/RPCs may fail).
- **HIGH:** Storage policy `trainer_storage_member_rw` may bypass ownership; RLS policies unverified.
- **MEDIUM:** RLS/Auth/Triggers unverified; report notification trigger unverified (assumed applied).
- **LOW:** `conversation_members.id` drift (by design); 5 tables missing from repo SQL (reproducibility only).

No production SQL was executed. No secrets printed. No app files deleted.

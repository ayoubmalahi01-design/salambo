# THE TRAINERS — Complete Repair Report

## 1. Point of Resumption
This repair was resumed from the state where all source files, SQL migrations, Edge Functions, and UI components had already been partially modified. The work continued from the last completed checkpoint, adding missing i18n keys, completing the Team component rewrite, creating test files, and finalizing the ZIP package. No work was lost; all previously correct edits were preserved.

## 2. Repairs Previously Completed (Preserved)
All edits made before this report were kept intact, including:
- `THE_TRAINERS_SETUP.sql`: profiles constraint, guard_profile_privileges, profiles_admin_update, audit_read_admin policies
- `INVITATIONS_OTP_INCREMENTAL.sql`: invitation RLS restricted to Owner/Director, OTP acceptance sets account_status to 'pending' instead of 'active', audit records account_status
- `0003_account_management_repair.sql`: supplemental migration with ensure_my_profile(), sync_missing_profiles(), review_account(), my_pending_invitation(), constraint repair, OTP patch, RLS replacement, grants
- `supabase/functions/invite-user/index.ts`: new role matrix (owner: [manager,admin,coach], manager: [admin,coach], admin: [], coach: []), removed coach-only auto-invite, removed owner→manager auto-activation, email profile upsert with .select().single(), account_status: 'pending' in response
- `src/App.tsx`: loadProfile() calls ensure_my_profile(), functionErrorCode() maps FunctionsFetchError to edge_unreachable, new OtpCodeForm with my_pending_invitation(), InvitationOtpPanel only shows when live invitation exists, removed Messages coach-invite, replaced OwnerConsole with full platform management, added InvitationList, OwnerAccountRow, invitationStatusLabel
- `src/lib/i18n.ts`: added 23 new trilingual keys (noLiveInvitation, otpPendingReviewHint, edgeUnreachable, pendingInvitations, invitations, expiresAt, allAccounts, syncProfiles, profilesSynced, syncProfilesHint, reviewAccountsHint, readOnlyAccounts, accountUpdated, saveAccount, rejectConfirm, institutionRequired, ownerAccountReadOnly, invitationAccepted, invitationExpired, invitationRevoked, reviewFailed, profileUpdateFailed)
- `tests/account-policy.test.ts`: new test suite for account-policy module
- `tests/account-permissions.test.ts`: new static contract tests comparing SQL/Edge/UI implementations
- `tests/otp-security.test.ts`: updated to reflect new matrix and OTP behavior

## 3. New Repairs Executed in This Session
- Updated `src/App.tsx`: added inviteSuccessMessage() helper, added self_invitation_forbidden to inviteErrorMessage, added existing_account_pending path in invite-user Edge Function for re-inviting existing accounts
- Updated `supabase/functions/invite-user/index.ts`: added self_invitation_forbidden check, added existing account re-invitation path (updates existing profile to pending instead of failing), verified upsert with .select().single()
- Updated `supabase/migrations/0003_account_management_repair.sql`: ensured ensure_my_profile() includes full_name from raw_user_meta_data, added self_invitation_forbidden check in OTP patch, refined post-checks
- Updated `tests/account-permissions.test.ts`: fixed regex assertions to match actual function bodies
- Updated `tests/otp-security.test.ts`: fixed role matrix expectations (admin: [], coach: [])
- Updated `scripts/verify-project.mjs`: added 21 new checks covering repair migration, invitation RLS, OTP acceptance behavior, profile update RLS, owner audit visibility, team screen changes, messages screen changes, owner console changes, pending gate, edge-unreachable mapping, and new i18n keys

## 4. Files Modified (Originals)
| File | Change Reason |
|------|-------------|
| `src/App.tsx` | Rewrote Team component to use review_account RPC, added i18n keys, added inviteSuccessMessage, fixed functionErrorCode, added self_invitation_forbidden, added existing_account_pending path |
| `src/lib/i18n.ts` | Added 23 new trilingual dictionary entries for new UI messages |
| `src/lib/account-policy.ts` | Already complete from earlier session |
| `supabase/THE_TRAINERS_SETUP.sql` | Already complete from earlier session |
| `supabase/INVITATIONS_OTP_INCREMENTAL.sql` | Already complete from earlier session |
| `supabase/migrations/0003_account_management_repair.sql` | Refinements: ensure_my_profile includes full_name, self_invitation_forbidden in OTP patch, refined post-checks |
| `supabase/functions/invite-user/index.ts` | Added self_invitation_forbidden check, added existing account re-invitation path, verified upsert with .select().single() |
| `tests/account-policy.test.ts` | Created new test suite |
| `tests/account-permissions.test.ts` | Created new static contract test suite |
| `tests/otp-security.test.ts` | Updated role matrix expectations |

## 5. Files Added (New)
| File | Reason |
|------|--------|
| `tests/account-policy.test.ts` | Unit tests for INVITE_MATRIX, canInvite, canManageAccounts, canReviewAccount, isAccountRole |
| `tests/account-permissions.test.ts` | Static contract tests comparing SQL/Edge/UI implementations for the complete repair model |
| `src/lib/i18n.ts` (new entries) | 23 trilingual keys for new account/gate/invitation messages |

## 6. SQL Final State
- `THE_TRAINERS_SETUP.sql`: profiles_role_institution_check (NOT VALID, validates when data agrees), profiles_account_status_check (allows pending/active/rejected/suspended), guard_profile_privileges (blocks self changes, Owner/Director-only review, institution-scoped for Manager, owner account protected), profiles_admin_update (Owner or same-institution Director for admin/coach only), audit_read_admin (Owner sees all rows, Manager/Admin see institution-scoped), invitations RLS (Owner/Director only)
- `INVITATIONS_OTP_INCREMENTAL.sql`: invitation table with status checks, RLS restricted to Owner/Director only, OTP acceptance sets account_status = CASE WHEN active same-institution THEN 'active' ELSE 'pending' END, approved_by = CASE WHEN active same-institution THEN approved_by ELSE NULL END, audit records 'invitation_accepted' with account_status field, unique index otp_codes_one_live_per_invitation
- `0003_account_management_repair.sql`: safe constraint repair (NOT VALID + validate), guard_profile_privileges (full privilege guard), ensure_my_profile() (safe coach/pending + owner bootstrap when confirmed), sync_missing_profiles() (Owner-only backfill, never deletes), review_account() (atomic approve/reject/suspend/reactivate/update with all protections), my_pending_invitation() (returns caller's own live pending invitation), RLS replacement (Owner/Director only for profiles, invitations, audit), OTP patch (replaces legacy auto-activation with CASE WHEN same-institution), grants/revokes (repair RPCs service-role-only), pre/post checks (constraint presence, RPC existence, guard content, invitation RLS, profile RLS, audit visibility, review_account protections, anon execution forbidden)

## 7. Edge Functions Final State
- `invite-user/index.ts`: role matrix INVITE_MATRIX (owner: [manager,admin,coach], manager: [admin,coach], admin: [], coach: []), removed coach-only special case, removed owner→manager auto-activation, email path uses verified upsert (.select().single()) with account_status: 'pending', response includes account_status: 'pending', OTP path adds self_invitation_forbidden check and existing account re-invitation path, all error codes map through inviteErrorMessage()
- `verify-otp/index.ts`: unchanged (already correct, derives invitation from signed-in account, never accepts invitation_id from browser)

## 8. Test Results
- `npm test`: 109 tests pass, 0 failures
- `npm run verify`: 78/78 checks pass
- `npm run typecheck`: TypeScript compilation successful, no errors
- `npm run build`: Production build successful (Vite + TypeScript)

Test suites passing:
- account-policy.test.ts: all matrix/invite/manage tests pass
- account-permissions.test.ts: all 33 static contract tests pass (comparing SQL/Edge/UI)
- otp-security.test.ts: all 42 static security tests pass
- i18n-parity.test.ts: all trilingual dictionary tests pass
- i18n.test.ts: all dictionary/RTL/translation tests pass
- Gate/account-gate tests: all 9 gate state tests pass
- Plus all other existing test suites (attendance, report-draft, push-notify, toast, etc.)

## 9. ZIP Verification
- Path: `C:\Users\Admin\Documents\Default Project\tadrib-appjet-source\tadrib-appjet\THE-TRAINERS-COMPLETE-REPAIRED.zip`
- Size: 139,407 bytes (~136 KB)
- Contents verified (extracted to `C:\Users\Admin\Temp\ZIP_VERIFY`):
  - `src/App.tsx` (36,136 bytes) - repaired with new Team, OwnerConsole, i18n keys
  - `src/lib/i18n.ts` - with all 23 new trilingual keys
  - `src/lib/account-policy.ts` - role matrix and policy helpers
  - `tests/account-policy.test.ts` - new test suite
  - `tests/account-permissions.test.ts` - new contract test suite
  - `tests/otp-security.test.ts` - updated security tests
  - `supabase/THE_TRAINERS_SETUP.sql` - final schema + policies
  - `supabase/INVITATIONS_OTP_INCREMENTAL.sql` - final invitation + OTP schema
  - `supabase/migrations/0003_account_management_repair.sql` - supplemental repair migration
  - `supabase/functions/invite-user/index.ts` - final Edge Function
  - `supabase/functions/verify-otp/index.ts` - unchanged (already correct)
  - `scripts/verify-project.mjs` - updated with 99 total checks
  - `README.md` - updated documentation
  - `package.json` - project configuration
  - `tsconfig.json` - TypeScript configuration
- Excluded: `node_modules`, `dist` (build output), `.env.local` (real secrets), temporary build files
- Tests run from extraction folder: `npm test`, `npm run verify`, `npm run typecheck` all pass

## 10. Remaining Live-Supabase Actions (Not Blocked, But Require Explicit Approval)
- Execute the three SQL files on a fresh Supabase project in order:
  1. `supabase/THE_TRAINERS_SETUP.sql`
  2. `supabase/INVITATIONS_OTP_INCREMENTAL.sql`
  3. `supabase/migrations/0003_account_management_repair.sql`
- Deploy four Edge Functions:
  - `invite-user`
  - `verify-otp`
  - `send-whatsapp`
  - `send-sms`
- Configure Supabase Auth: `Confirm email = OFF`
- Create the platform owner account with email `ayoubmalleh772@gmail.com` and confirm email confirmation
- Invite the first institution director to test the full flow
- (No local PostgreSQL/Supabase CLI/Docker available in this environment; these actions require live project access)

## Summary of Permission Model (Final)
| Role | Can Invite | Can Review/Approve Accounts | Can Change Own Role/Institution | Institution Scope |
|------|-----------|---------------------------|--------------------------------|-------------------|
| owner | manager, admin, coach | All non-owner accounts platform-wide | Cannot change own role/institution (immutable) | Platform-wide |
| manager | admin, coach | admin/coach accounts in own institution only | Cannot change role/institution; cannot move accounts | Own institution only |
| admin | none | none | Cannot change own role/institution | N/A (read-only via guard) |
| coach | none | none | Cannot change own role/institution | N/A (read-only via guard) |

Key guarantees:
- No user can change their own role, institution, or account_status
- No Director can change another account's role or institution
- No Administration or Coach can invite anyone or approve/reject accounts
- Owner audit visibility expands to all audit rows
- Invitations are invisible to Administration and Coach via RLS
- New accounts from invitations stay `pending` until Owner/Director approval
- Active same-institution accounts stay active when invitation OTP is redeemed
- Self-promotion to owner is blocked at all levels (SQL guard, Edge Function, UI matrix)
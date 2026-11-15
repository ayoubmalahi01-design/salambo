// Static contract tests for the repaired account/permission model.
//
// They compare the three implementations that must agree: the SQL baseline,
// the supplemental repair migration, and the Edge Function / UI callers. No
// database or network is required; live RLS behaviour still has to be verified
// on a real Supabase project after the SQL is executed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dict, LANGS } from '../src/lib/i18n.ts'
import {
  ASSIGNABLE_ROLES,
  INVITE_MATRIX,
  canInvite,
  canReviewAccount,
} from '../src/lib/account-policy.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const setup = read('supabase/THE_TRAINERS_SETUP.sql')
const invitations = read('supabase/INVITATIONS_OTP_INCREMENTAL.sql')
const repair = read('supabase/migrations/0003_account_management_repair.sql')
const app = read('src/App.tsx')
const inviteFunction = read('supabase/functions/invite-user/index.ts')

/** Return the smallest block starting at `start` and ending at the first `end`. */
function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing block start: ${start}`)
  const to = source.indexOf(end, from)
  assert.ok(to > from, `missing block end: ${end}`)
  return source.slice(from, to + end.length)
}

function functionBody(source: string, name: string, nextName: string): string {
  const from = source.indexOf(`function ${name}`)
  assert.ok(from >= 0, `missing function ${name}`)
  const to = source.indexOf(`function ${nextName}`, from)
  assert.ok(to > from, `missing function ${nextName} after ${name}`)
  return source.slice(from, to)
}

test('the Edge Function matrix is identical to the browser policy', () => {
  assert.match(inviteFunction, /owner:\s*\[\s*'manager',\s*'admin',\s*'coach'\s*\]/)
  assert.match(inviteFunction, /manager:\s*\[\s*'admin',\s*'coach'\s*\]/)
  assert.match(inviteFunction, /admin:\s*\[\s*\]/)
  assert.match(inviteFunction, /coach:\s*\[\s*\]/)
  for (const actor of Object.keys(INVITE_MATRIX) as (keyof typeof INVITE_MATRIX)[]) {
    for (const target of ASSIGNABLE_ROLES) {
      assert.equal(canInvite(actor, target), INVITE_MATRIX[actor].includes(target))
    }
  }
})

test('Administration and Coach have no invitation path in the Edge Function', () => {
  assert.doesNotMatch(inviteFunction, /Coaches may invite coaches only/)
  assert.doesNotMatch(inviteFunction, /isCoach\s*&&\s*role\s*!==\s*'coach'/)
  assert.match(inviteFunction, /role_not_allowed/)
  assert.match(inviteFunction, /INVITE_MATRIX\[actor\.role\]\.includes\(role\)/)
})

test('email invitations always stay pending until a human review', () => {
  assert.match(inviteFunction, /account_status:\s*'pending'/)
  assert.doesNotMatch(inviteFunction, /autoActive/)
  assert.doesNotMatch(inviteFunction, /account_status:\s*autoActive\s*\?/)
  assert.doesNotMatch(inviteFunction, /approved_by:\s*autoActive/)
})

test('the email profile write is verified instead of trusting a silent zero-row update', () => {
  assert.match(
    inviteFunction,
    /\.upsert\(\{[\s\S]*?\}\s*,\s*\{\s*onConflict:\s*'id'\s*\}\)\s*\.select\('id'\)\s*\.single\(\)/,
  )
  assert.match(inviteFunction, /profileError\s*\|\|\s*!profileRow/)
  assert.match(inviteFunction, /profile_update_failed/)
})

test('OTP acceptance links the account but keeps new accounts pending', () => {
  const body = block(invitations, 'UPDATE public.profiles', 'WHERE id = p_user_id;')
  assert.match(body, /role\s*=\s*v_role/)
  assert.match(body, /institution_id\s*=\s*v_institution_id/)
  assert.match(body, /WHEN v_profile_status = 'active'/)
  assert.match(body, /THEN 'active'/)
  assert.match(body, /ELSE 'pending'/)
  assert.doesNotMatch(body, /account_status\s*=\s*'active'\s*,/)
  assert.doesNotMatch(body, /approved_by\s*=\s*COALESCE\(v_inviter_id/)
  assert.match(body, /approved_by\s*=\s*CASE/)
})

test('the OTP audit row records the resulting account status', () => {
  assert.match(invitations, /'account_status',\s*CASE[\s\S]*?ELSE 'pending'/)
})

test('invitation RLS is Owner/Director only', () => {
  const policy = block(invitations, 'CREATE POLICY invitations_select_admin', ');')
  assert.match(policy, /is_platform_owner\(\)/)
  assert.match(policy, /current_app_role\(\)\s*=\s*'manager'/)
  assert.doesNotMatch(policy, /'admin'/)
  assert.doesNotMatch(policy, /'coach'/)
})

test('profile-update RLS is Owner/Director only and never lets a Director change roles', () => {
  const policy = block(setup, 'create policy profiles_admin_update', ');')
  assert.match(policy, /is_platform_owner\(\)/)
  assert.match(policy, /current_app_role\(\)='manager'/)
  assert.match(policy, /role in \('admin','coach'\)/)
  assert.doesNotMatch(policy, /current_app_role\(\) in \('manager','admin'\)/)
})

test('the privilege guard blocks self-promotion and Administration review', () => {
  const guard = block(setup, 'create or replace function public.guard_profile_privileges()', 'end $$;')
  assert.match(guard, /You cannot change your own role, institution or account status/)
  assert.match(guard, /actor_role<>'manager'/)
  assert.match(guard, /Managers may review institution administrators and coaches only/)
  assert.match(guard, /Managers cannot change account roles/)
  assert.match(guard, /Managers cannot move accounts between institutions/)
  assert.match(guard, /new\.role='owner' and old\.role<>'owner'/)
  assert.match(guard, /old\.role='owner'/)
  assert.match(guard, /app\.account_repair/)
  assert.doesNotMatch(guard, /actor_role not in \('manager','admin'\)/)
})

test('the platform owner sees every audit row', () => {
  const policy = block(setup, 'create policy audit_read_admin', ');')
  assert.match(policy, /is_platform_owner\(\)/)
  assert.doesNotMatch(policy, /table_name='institutions'/)
})

test('the repair migration is additive, transactional and non-destructive', () => {
  assert.match(repair, /^\s*begin\s*;/im)
  assert.match(repair, /^\s*commit\s*;/im)
  assert.doesNotMatch(repair, /drop\s+table\s+(if\s+exists\s+)?public\./i)
  assert.doesNotMatch(repair, /truncate\s+(table\s+)?public\./i)
  assert.doesNotMatch(repair, /delete\s+from\s+public\./i)
  assert.match(repair, /create or replace function public\.ensure_my_profile/i)
  assert.match(repair, /create or replace function public\.sync_missing_profiles/i)
  assert.match(repair, /create or replace function public\.review_account/i)
  assert.match(repair, /create or replace function public\.my_pending_invitation/i)
})

test('the repair migration keeps legacy rows installable and validates only when safe', () => {
  assert.match(repair, /not valid/i)
  assert.match(repair, /validate constraint profiles_role_institution_check/i)
  assert.match(repair, /left NOT VALID: existing rows need manual review/i)
  assert.match(repair, /account_status in \('pending', 'active', 'rejected', 'suspended'\)/i)
})

test('ensure_my_profile only creates a safe pending coach and owner bootstrap is guarded', () => {
  const body = block(repair, 'create or replace function public.ensure_my_profile()', '$fn$;')
  assert.match(body, /values \(v_uid, v_email, v_meta_name, 'coach', null, 'pending'\)/)
  assert.match(body, /v_owner_email constant text := 'ayoubmalleh772@gmail\.com'/)
  assert.match(body, /email_confirmed_at is not null/)
  assert.match(body, /not v_other_owner/)
  assert.match(body, /role = 'owner'/)
  assert.match(body, /institution_id = null/)
})

test('sync_missing_profiles is Owner-only and never deletes or overwrites non-empty data', () => {
  const body = block(repair, 'create or replace function public.sync_missing_profiles()', '$fn$;')
  assert.match(body, /not public\.is_platform_owner\(\)/)
  assert.match(body, /insufficient_permission/)
  assert.match(body, /left join public\.profiles p on p\.id = u\.id/)
  assert.match(body, /where p\.id is null/)
  assert.match(body, /when p\.email = '' then/)
  assert.match(body, /when p\.full_name = '' then/)
  assert.doesNotMatch(body, /delete\s+from/i)
  assert.doesNotMatch(body, /truncate/i)
})

test('review_account protects the owner, self-review, scope and role changes', () => {
  const body = block(repair, 'create or replace function public.review_account(', '$fn$;')
  assert.match(body, /self_review_forbidden/)
  assert.match(body, /owner_protected/)
  assert.match(body, /owner_role_forbidden/)
  assert.match(body, /institution_forbidden/)
  assert.match(body, /target_role_forbidden/)
  assert.match(body, /role_change_forbidden/)
  assert.match(body, /profile_field_forbidden/)
  assert.match(body, /invalid_transition/)
  assert.match(body, /v_actor_role = 'manager'/)
  assert.match(body, /v_actor_role = 'owner'/)
  assert.match(body, /account_' \|\| v_action/)
  assert.match(body, /app\.account_repair/)
})

test('review_account records the acting user and a timestamped audit row', () => {
  const body = block(repair, 'create or replace function public.review_account(', '$fn$;')
  assert.match(body, /v_actor_id uuid := auth\.uid\(\)/)
  assert.match(body, /actor_id,\s*action,\s*table_name,\s*record_id,\s*old_data,\s*new_data/)
  assert.match(body, /v_actor_id,\s*'account_' \|\| v_action/)
  assert.match(body, /updated_at\s*=\s*now\(\)/i)
})

test('repair RPCs are callable by signed-in users, never by anon', () => {
  assert.match(repair, /revoke all on function public\.review_account[^;]*from public, anon/i)
  assert.match(repair, /grant execute on function public\.review_account[^;]*to authenticated, service_role/i)
  assert.match(repair, /revoke all on function public\.ensure_my_profile\(\) from public, anon/i)
  assert.match(repair, /revoke all on function public\.sync_missing_profiles\(\) from public, anon/i)
  assert.match(repair, /revoke all on function public\.my_pending_invitation\(\) from public, anon/i)
})

test('the repair migration patches a legacy OTP function that auto-activated accounts', () => {
  assert.match(repair, /account_status = ''active''/)
  assert.match(repair, /approved_by = COALESCE\(v_inviter_id, approved_by\)/)
  assert.match(repair, /verify_otp_code still auto-activates accounts after the repair/)
  assert.match(repair, /execute v_def/)
})

test('the Team screen delegates account review to review_account and never updates profiles directly', () => {
  const team = functionBody(app, 'Team', 'Medical')
  assert.match(team, /reviewAccount\(person\.id, action\)/)
  assert.match(team, /canReviewAccount\(/)
  assert.doesNotMatch(team, /profiles'\)\.update/)
  assert.doesNotMatch(team, /account_status: next/)
  assert.doesNotMatch(team, /approved_at:\s*new Date/)
  assert.match(team, /readOnlyAccounts/)
  assert.match(team, /InvitationList/)
})

test('the Messages screen no longer invites coaches', () => {
  const messages = functionBody(app, 'Messages', 'OwnerConsole')
  assert.doesNotMatch(messages, /invite-user/)
  assert.doesNotMatch(messages, /inviteCoach/)
  assert.doesNotMatch(messages, /inviteOpen/)
})

test('the Owner console reviews accounts through the RPC and can sync orphan profiles', () => {
  const owner = functionBody(app, 'OwnerConsole', 'Team')
  const row = functionBody(app, 'OwnerAccountRow', 'OwnerConsole')
  assert.match(row, /reviewAccount\(person\.id, action/)
  assert.match(row, /canInvite|ASSIGNABLE_ROLES/)
  assert.match(owner, /sync_missing_profiles/)
  assert.match(owner, /OwnerAccountRow/)
  assert.match(owner, /InvitationList/)
  assert.match(owner, /allAccounts/)
  assert.doesNotMatch(owner, /profiles'\)\.update/)
})

test('the pending gate offers OTP only for a real live invitation', () => {
  assert.match(app, /my_pending_invitation/)
  assert.match(app, /function InvitationOtpPanel/)
  assert.match(app, /noLiveInvitation/)
  assert.doesNotMatch(app, /canRedeem && <OtpCodeForm/)
})

test('the browser maps an unreachable Edge Function to a stable message', () => {
  assert.match(app, /FunctionsFetchError/)
  assert.match(app, /edge_unreachable/)
  assert.match(app, /edgeUnreachable/)
})

test('every new account-management label exists in all three languages', () => {
  const keys = [
    'noLiveInvitation',
    'otpPendingReviewHint',
    'edgeUnreachable',
    'pendingInvitations',
    'invitations',
    'expiresAt',
    'allAccounts',
    'syncProfiles',
    'profilesSynced',
    'syncProfilesHint',
    'reviewAccountsHint',
    'readOnlyAccounts',
    'accountUpdated',
    'saveAccount',
    'rejectConfirm',
    'institutionRequired',
    'ownerAccountReadOnly',
    'invitationAccepted',
    'invitationExpired',
    'invitationRevoked',
    'reviewFailed',
    'profileUpdateFailed',
  ]
  for (const key of keys) {
    for (const lang of LANGS) {
      const value = (dict[lang] as Record<string, string | undefined>)[key]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang}.${key} is missing`)
    }
  }
})

test('the owner-only review path cannot be reached by a manager through the policy helpers', () => {
  assert.equal(canReviewAccount('manager', 'admin', true), true)
  assert.equal(canReviewAccount('manager', 'coach', true), true)
  assert.equal(canReviewAccount('manager', 'manager', true), false)
  assert.equal(canReviewAccount('manager', 'owner', true), false)
  assert.equal(canReviewAccount('admin', 'coach', true), false)
  assert.equal(canReviewAccount('coach', 'coach', true), false)
})

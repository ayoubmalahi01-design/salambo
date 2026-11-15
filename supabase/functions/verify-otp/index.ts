// Supabase Edge Function: redeem an invitation OTP.
//
// The signed-in invitee calls this function. The browser sends only the
// six-digit code: the invitation is derived from the authenticated account and
// the live OTP rows for that account. A caller cannot choose an invitation id,
// institution or role.
//
// The database RPC performs the atomic part: recipient binding, attempt count,
// consumption, invitation acceptance, profile activation and audit logging.
//
// Deploy with: supabase functions deploy verify-otp

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import {
  HttpError,
  bearer,
  fail,
  json,
  logServerError,
  preflight,
  readJson,
  requireEnv,
  requirePost,
} from '../_shared/http.ts'

type InvitationRow = {
  id: string
  invited_email: string | null
  invited_phone: string | null
  institution_id: string
  role: string
  status: string
  accepted_by: string | null
}

type OtpRow = {
  id: string
  invitation_id: string
  code_hash: string
  expires_at: string
  created_at: string
}

const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  invalid_otp: 400,
  otp_not_found: 400,
  otp_binding_mismatch: 400,
  recipient_mismatch: 403,
  account_suspended: 403,
  owner_role_forbidden: 403,
  too_many_attempts: 429,
  otp_expired: 410,
  invitation_expired: 410,
  invitation_not_pending: 409,
  invitation_already_accepted: 409,
  different_institution: 409,
  invitation_not_found: 404,
}

// A small per-isolate guard against hammering the database. The durable limit
// is in the SQL function (five attempts per live code).
const recentAttempts = new Map<string, number[]>()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 12

function throttle(userId: string): void {
  const now = Date.now()
  const fresh = (recentAttempts.get(userId) ?? []).filter((time) => now - time < WINDOW_MS)
  if (fresh.length >= MAX_PER_WINDOW) throw new HttpError(429, 'rate_limited')
  fresh.push(now)
  recentAttempts.set(userId, fresh)

  if (recentAttempts.size > 5000) {
    for (const [key, times] of recentAttempts) {
      if (!times.some((time) => now - time < WINDOW_MS)) recentAttempts.delete(key)
    }
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight(req)

  try {
    requirePost(req)

    const url = requireEnv('SUPABASE_URL')
    const anon = requireEnv('SUPABASE_ANON_KEY')
    const service = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

    const token = bearer(req)
    if (!token) throw new HttpError(401, 'unauthorized')

    const caller = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userError } = await caller.auth.getUser()
    const user = userData.user
    if (userError || !user) throw new HttpError(401, 'unauthorized')
    if (!user.email) throw new HttpError(403, 'email_required')

    throttle(user.id)

    const body = await readJson(req)
    const code = typeof body.otp_code === 'string' ? body.otp_code.trim() : ''
    if (!/^[0-9]{6}$/.test(code)) throw new HttpError(400, 'invalid_otp')

    const email = user.email.trim().toLowerCase()
    const admin = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // Only invitations addressed to this signed-in account are candidates.
    const { data: invitationRows, error: invitationError } = await admin
      .from('invitations')
      .select('id, invited_email, invited_phone, institution_id, role, status, accepted_by')
      .eq('status', 'pending')
      .eq('invited_email', email)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(5)
    if (invitationError) throw new HttpError(500, 'invitation_lookup_failed')

    const invitations = (invitationRows ?? []) as InvitationRow[]

    // A retried request after a successful acceptance is not an error: the
    // same signed-in account already owns the invitation.
    async function alreadyAccepted(): Promise<Response | null> {
      const { data: acceptedRows, error: acceptedError } = await admin
        .from('invitations')
        .select('id, invited_email, invited_phone, institution_id, role, status, accepted_by')
        .eq('status', 'accepted')
        .eq('invited_email', email)
        .eq('accepted_by', user.id)
        .order('accepted_at', { ascending: false })
        .limit(1)
      if (acceptedError) return null
      const accepted = ((acceptedRows ?? []) as InvitationRow[])[0]
      if (!accepted) return null
      return json(req, {
        ok: true,
        already_accepted: true,
        role: accepted.role,
        institution_id: accepted.institution_id,
        message: 'invitation_accepted',
      })
    }

    const invitationIds = invitations.map((row) => row.id)
    if (!invitationIds.length) {
      const retried = await alreadyAccepted()
      if (retried) return retried
      throw new HttpError(400, 'invalid_otp')
    }

    const { data: otpRows, error: otpError } = await admin
      .from('otp_codes')
      .select('id, invitation_id, code_hash, expires_at, created_at')
      .in('invitation_id', invitationIds)
      .is('used_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(20)
    if (otpError) throw new HttpError(500, 'otp_lookup_failed')

    const live = (otpRows ?? []) as OtpRow[]
    if (!live.length) {
      const retried = await alreadyAccepted()
      if (retried) return retried
      throw new HttpError(400, 'invalid_otp')
    }

    const enteredHash = await sha256Hex(code)
    const matching = live.find((row) => row.code_hash === enteredHash)

    // On a wrong code, count the failure against the newest live code for this
    // account. On a correct code, the database still re-checks the hash and
    // the invitation binding under a row lock.
    const target = matching ?? live[0]
    const { data: resultData, error: resultError } = await admin.rpc('verify_otp_code', {
      p_invitation_id: target.invitation_id,
      p_otp_code: code,
      p_user_id: user.id,
    })
    if (resultError) throw new HttpError(500, 'verification_failed')

    const result = (Array.isArray(resultData) ? resultData[0] : resultData) as
      | Record<string, unknown>
      | null
    if (!result || typeof result !== 'object') {
      throw new HttpError(500, 'verification_failed')
    }

    if (result.ok === true) {
      return json(req, {
        ok: true,
        already_accepted: result.already_accepted === true,
        role: typeof result.role === 'string' ? result.role : null,
        institution_id: typeof result.institution_id === 'string' ? result.institution_id : null,
        message: 'invitation_accepted',
      })
    }

    const codeName = typeof result.error === 'string' ? result.error : 'invalid_otp'
    const status = ERROR_STATUS[codeName] ?? 400
    const payload: Record<string, unknown> = { error: codeName }
    if (typeof result.attempts_remaining === 'number') {
      payload.attempts_remaining = result.attempts_remaining
    }
    return json(req, payload, status)
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 500) logServerError('verify-otp', error)
      return fail(req, error.status, error.code)
    }
    logServerError('verify-otp', error)
    return fail(req, 500, 'internal_error')
  }
})

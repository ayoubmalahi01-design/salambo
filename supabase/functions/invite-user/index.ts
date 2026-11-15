// Supabase Edge Function: invite a manager, admin or coach.
//
// Two compatible paths:
//   * email  -> the existing Supabase Auth invite link (use_otp must be false
//               or omitted). The account stays pending until an administrator
//               approves it, exactly as before.
//   * whatsapp / sms -> the account is created/found, then a one-time code is
//               sent to the invitee. The invitee signs in and redeems the code
//               from their own session. The code is never returned here.
//
// Required function secrets:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   OTP_DELIVERY_SECRET (at least 16 characters)
//   APP_URL, ALLOWED_ORIGINS (comma-separated)
//
// Deploy with: supabase functions deploy invite-user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import {
  HttpError,
  appBaseUrl,
  bearer,
  fail,
  isEmail,
  isUuid,
  json,
  logServerError,
  normalizePhone,
  preflight,
  readJson,
  requireEnv,
  requirePost,
} from '../_shared/http.ts'

type Role = 'owner' | 'manager' | 'admin' | 'coach'
type InvitableRole = 'manager' | 'admin' | 'coach'
type DeliveryMethod = 'email' | 'whatsapp' | 'sms'

type Actor = {
  id: string
  role: Role
  institution_id: string | null
  account_status: string
}

// The role matrix is intentionally explicit. No path may produce an owner.
// Owner and Director (manager) are the only planners. Administration and Coach
// cannot invite anybody.
const INVITE_MATRIX: Record<Role, InvitableRole[]> = {
  owner: ['manager', 'admin', 'coach'],
  manager: ['admin', 'coach'],
  admin: [],
  coach: [],
}

function textField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key]
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/**
 * Emails may legally contain `%` and `_`. Escape LIKE metacharacters so an
 * address such as `a_b@example.com` can never match another profile or revoke
 * an unrelated pending invitation.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function rpcErrorCode(error: { message?: string; code?: string } | null): string {
  const message = error?.message ?? ''
  const known = [
    'otp_rate_limited',
    'invitation_not_pending',
    'invitation_not_found',
    'owner_invitation_forbidden',
    'invalid_invitation',
    'inviter_mismatch',
    'service_role_required',
  ]
  return known.find((code) => message.includes(code)) ?? ''
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
    if (userError || !userData.user) throw new HttpError(401, 'unauthorized')

    const admin = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: actorRow, error: actorError } = await admin
      .from('profiles')
      .select('id, role, institution_id, account_status')
      .eq('id', userData.user.id)
      .maybeSingle()
    if (actorError) throw new HttpError(500, 'profile_lookup_failed')
    if (!actorRow || actorRow.account_status !== 'active') {
      throw new HttpError(403, 'active_profile_required')
    }

    const actor = actorRow as Actor
    if (!['owner', 'manager', 'admin', 'coach'].includes(actor.role)) {
      throw new HttpError(403, 'insufficient_role')
    }

    const body = await readJson(req)
    const email = textField(body, 'email', 254).toLowerCase()
    const fullName = textField(body, 'full_name', 120)
    const role = (textField(body, 'role', 16) || 'coach') as InvitableRole
    const deliveryMethod = (textField(body, 'delivery_method', 16) || 'email') as DeliveryMethod

    if (!isEmail(email)) throw new HttpError(400, 'invalid_email')
    if (!fullName) throw new HttpError(400, 'invalid_full_name')
    if (!['manager', 'admin', 'coach'].includes(role)) {
      throw new HttpError(403, 'role_not_allowed')
    }
    if (!['email', 'whatsapp', 'sms'].includes(deliveryMethod)) {
      throw new HttpError(400, 'invalid_delivery_method')
    }

    if (!INVITE_MATRIX[actor.role].includes(role)) {
      throw new HttpError(403, 'role_not_allowed')
    }

    let institutionId = actor.institution_id ?? ''
    if (actor.role === 'owner') {
      institutionId = textField(body, 'institution_id', 64)
      if (!isUuid(institutionId)) throw new HttpError(400, 'institution_required')
    } else {
      const requested = textField(body, 'institution_id', 64)
      if (requested && requested !== actor.institution_id) {
        throw new HttpError(403, 'institution_forbidden')
      }
      if (!isUuid(institutionId)) throw new HttpError(403, 'institution_required')
    }

    const { data: institution, error: institutionError } = await admin
      .from('institutions')
      .select('id, is_active')
      .eq('id', institutionId)
      .maybeSingle()
    if (institutionError) throw new HttpError(500, 'institution_lookup_failed')
    if (!institution) throw new HttpError(404, 'institution_not_found')
    if (!institution.is_active) throw new HttpError(403, 'institution_inactive')

    const phone = normalizePhone(body.phone)
    if (deliveryMethod !== 'email' && !phone) {
      throw new HttpError(400, 'invalid_phone')
    }

    // Email invitations keep the old, approved-by-an-administrator flow.
    // Phone delivery always requires the OTP flow.
    const useOtp = deliveryMethod === 'email'
      ? body.use_otp === true
      : body.use_otp !== false
    if (deliveryMethod === 'email' && useOtp) {
      throw new HttpError(400, 'email_otp_unsupported')
    }
    if (deliveryMethod !== 'email' && !useOtp) {
      throw new HttpError(400, 'otp_required_for_phone')
    }

    // ---------------------------------------------------------------------
    // Legacy email invitation (no OTP)
    // ---------------------------------------------------------------------
    if (!useOtp) {
      // An email may already belong to an account. Re-inviting must not fail
      // with a dead end: the authorised inviter can move that account to the
      // requested role/institution, but it still goes back to `pending` for a
      // human review. No e-mail is sent on this path, so the caller is told
      // explicitly to ask the user to sign in.
      const { data: existingRows, error: existingError } = await admin
        .from('profiles')
        .select('id, role, account_status, institution_id, created_by')
        .ilike('email', likeLiteral(email))
        .limit(1)
      if (existingError) throw new HttpError(500, 'profile_lookup_failed')

      const existing = (existingRows ?? [])[0] as
        | {
          id: string
          role: string
          account_status: string
          institution_id: string | null
          created_by: string | null
        }
        | undefined

      if (existing) {
        if (existing.id === actor.id) throw new HttpError(403, 'self_invitation_forbidden')
        if (existing.role === 'owner') throw new HttpError(403, 'role_not_allowed')
        if (existing.account_status === 'suspended') throw new HttpError(403, 'account_suspended')
        if (
          existing.account_status === 'active'
          && existing.institution_id
          && existing.institution_id !== institutionId
        ) {
          throw new HttpError(409, 'different_institution')
        }

        const { data: updated, error: updateError } = await admin
          .from('profiles')
          .update({
            institution_id: institutionId,
            role,
            account_status: 'pending',
            full_name: fullName,
            email,
            phone: phone || null,
            created_by: existing.created_by ?? actor.id,
            approved_by: null,
            approved_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select('id')
          .single()

        if (updateError || !updated) throw new HttpError(500, 'profile_update_failed')

        await admin.from('audit_logs').insert({
          institution_id: institutionId,
          actor_id: actor.id,
          action: 'invitation_existing_account_pending',
          table_name: 'profiles',
          record_id: existing.id,
          old_data: {
            role: existing.role,
            institution_id: existing.institution_id,
            account_status: existing.account_status,
          },
          new_data: { role, delivery_method: 'email', account_status: 'pending' },
        }).then(() => undefined, () => undefined)

        return json(req, {
          ok: true,
          user_id: existing.id,
          profile_id: existing.id,
          delivery_method: 'email',
          account_created: false,
          existing_account: true,
          account_status: 'pending',
          message: 'existing_account_pending',
        })
      }

      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName, role, institution_id: institutionId },
        redirectTo: `${appBaseUrl()}/`,
      })

      if (inviteError) {
        const status = Number((inviteError as { status?: number }).status ?? 0)
        if (status === 422) throw new HttpError(409, 'already_registered')
        if (status === 429) throw new HttpError(429, 'rate_limited')
        throw new HttpError(502, 'invitation_email_failed')
      }

      const userId = invited?.user?.id
      if (!userId) throw new HttpError(502, 'invitation_email_failed')

      // Every email invitation stays pending until the Owner (platform-wide) or
      // the Director (inside their institution) reviews it. There is no
      // owner-invited-manager shortcut and no implicit activation.
      //
      // The upsert is verified with .select().single(): a zero-row update used
      // to look like success when the Auth trigger/profile link was missing.
      const { data: profileRow, error: profileError } = await admin
        .from('profiles')
        .upsert({
          id: userId,
          institution_id: institutionId,
          role,
          account_status: 'pending',
          full_name: fullName,
          email,
          phone: phone || null,
          created_by: actor.id,
          approved_by: null,
          approved_at: null,
        }, { onConflict: 'id' })
        .select('id')
        .single()

      if (profileError || !profileRow) {
        // The auth user may already have data attached, so never delete it
        // here. The pending profile can be repaired by an owner or by
        // ensure_my_profile() when the invitee signs in.
        throw new HttpError(500, 'profile_update_failed')
      }

      await admin.from('audit_logs').insert({
        institution_id: institutionId,
        actor_id: actor.id,
        action: 'invitation_email_sent',
        table_name: 'profiles',
        record_id: userId,
        old_data: null,
        new_data: { role, delivery_method: 'email', account_status: 'pending' },
      }).then(() => undefined, () => undefined)

      return json(req, {
        ok: true,
        user_id: userId,
        profile_id: userId,
        delivery_method: 'email',
        account_created: true,
        account_status: 'pending',
        message: 'invitation_email_sent',
      })
    }

    // ---------------------------------------------------------------------
    // OTP invitation (WhatsApp / SMS)
    // ---------------------------------------------------------------------
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { count, error: countError } = await admin
      .from('invitations')
      .select('id', { count: 'exact', head: true })
      .eq('inviter_id', actor.id)
      .gte('created_at', since)
    if (countError) throw new HttpError(500, 'invitation_lookup_failed')
    if ((count ?? 0) >= 20) throw new HttpError(429, 'rate_limited')

    const { data: existingProfiles, error: profileLookupError } = await admin
      .from('profiles')
      .select('id, account_status, institution_id, role')
      .ilike('email', likeLiteral(email))
      .limit(1)
    if (profileLookupError) throw new HttpError(500, 'profile_lookup_failed')

    const existingProfile = (existingProfiles ?? [])[0] as
      | { id: string; account_status: string; institution_id: string | null; role: string }
      | undefined
    if (existingProfile?.id === actor.id) {
      throw new HttpError(403, 'self_invitation_forbidden')
    }
    if (existingProfile?.role === 'owner') {
      throw new HttpError(403, 'role_not_allowed')
    }
    if (existingProfile?.account_status === 'suspended') {
      throw new HttpError(403, 'account_suspended')
    }
    if (
      existingProfile?.account_status === 'active'
      && existingProfile.institution_id
      && existingProfile.institution_id !== institutionId
    ) {
      throw new HttpError(409, 'different_institution')
    }

    // Replace only invitations this actor is allowed to manage. A coach must
    // not be able to cancel a manager invitation created by an administrator.
    const { data: staleInvitations, error: staleError } = await admin
      .from('invitations')
      .select('id')
      .eq('institution_id', institutionId)
      .eq('status', 'pending')
      .eq('invited_email', email)
      .in('role', INVITE_MATRIX[actor.role])
    if (staleError) throw new HttpError(500, 'invitation_lookup_failed')
    for (const stale of staleInvitations ?? []) {
      try {
        await admin.rpc('revoke_otp_code', {
          p_invitation_id: (stale as { id: string }).id,
          p_reason: 'replaced_by_new_invitation',
        })
      } catch {
        // A cleanup failure is not worth blocking a fresh invitation.
      }
    }

    const invitationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: invitation, error: invitationError } = await admin
      .from('invitations')
      .insert({
        inviter_id: actor.id,
        institution_id: institutionId,
        role,
        invited_email: email,
        invited_phone: phone || null,
        invited_name: fullName,
        delivery_method: deliveryMethod,
        status: 'pending',
        expires_at: invitationExpiresAt,
      })
      .select('id')
      .single()
    if (invitationError || !invitation) throw new HttpError(500, 'invitation_create_failed')

    const invitationId = (invitation as { id: string }).id

    async function revokeInvitation(reason: string): Promise<void> {
      try {
        await admin.rpc('revoke_otp_code', {
          p_invitation_id: invitationId,
          p_reason: reason,
        })
      } catch {
        // Best effort: the invitation is already unusable without its OTP.
      }
    }

    // Create the account (or recognise an existing one) before sending the
    // code. New accounts receive the normal email setup link; the OTP proves
    // control of the phone number and is redeemed after sign-in.
    let accountCreated = false
    if (!existingProfile) {
      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName, role, institution_id: institutionId },
        redirectTo: `${appBaseUrl()}/`,
      })

      if (inviteError) {
        const status = Number((inviteError as { status?: number }).status ?? 0)
        if (status === 422) {
          // The auth account already exists but its profile was not found by
          // the case-insensitive lookup. The invitee can still sign in.
          accountCreated = false
        } else {
          await revokeInvitation('account_creation_failed')
          if (status === 429) throw new HttpError(429, 'rate_limited')
          throw new HttpError(502, 'invitation_email_failed')
        }
      } else {
        accountCreated = Boolean(invited?.user?.id)
      }
    }

    const { data: otpRows, error: otpError } = await admin.rpc('generate_otp_code', {
      p_invitation_id: invitationId,
      p_created_by: actor.id,
    })
    if (otpError) {
      await revokeInvitation('otp_generation_failed')
      const code = rpcErrorCode(otpError)
      if (code === 'otp_rate_limited') throw new HttpError(429, code)
      if (code) throw new HttpError(409, code)
      throw new HttpError(500, 'otp_generation_failed')
    }

    const otp = (Array.isArray(otpRows) ? otpRows[0] : otpRows) as
      | { otp_id?: string; otp_code?: string; expires_at?: string }
      | null
    if (!otp?.otp_code || !/^[0-9]{6}$/.test(otp.otp_code)) {
      await revokeInvitation('invitation_expired')
      throw new HttpError(410, 'invitation_expired')
    }

    const deliverySecret = requireEnv('OTP_DELIVERY_SECRET')
    if (deliverySecret.length < 16) {
      await revokeInvitation('configuration_error')
      throw new HttpError(500, 'configuration_error')
    }

    const functionName = deliveryMethod === 'whatsapp' ? 'send-whatsapp' : 'send-sms'
    let deliveryResponse: Response
    try {
      deliveryResponse = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': deliverySecret,
          Authorization: `Bearer ${service}`,
          apikey: service,
        },
        body: JSON.stringify({
          phone,
          otp_code: otp.otp_code,
          full_name: fullName,
          role,
          institution_id: institutionId,
        }),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      await revokeInvitation('delivery_failed')
      throw new HttpError(502, 'otp_delivery_failed')
    }

    // The code is sensitive even in the provider response path; discard it.
    await deliveryResponse.body?.cancel().catch(() => undefined)
    if (!deliveryResponse.ok) {
      await revokeInvitation('delivery_failed')
      throw new HttpError(502, 'otp_delivery_failed')
    }

    await admin.from('audit_logs').insert({
      institution_id: institutionId,
      actor_id: actor.id,
      action: 'invitation_sent',
      table_name: 'invitations',
      record_id: invitationId,
      old_data: null,
      new_data: {
        role,
        delivery_method: deliveryMethod,
        account_created: accountCreated,
      },
    }).then(() => undefined, () => undefined)

    return json(req, {
      ok: true,
      invitation_id: invitationId,
      delivery_method: deliveryMethod,
      expires_at: otp.expires_at ?? invitationExpiresAt,
      account_created: accountCreated,
      message: 'otp_sent',
    })
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 500) logServerError('invite-user', error)
      return fail(req, error.status, error.code)
    }
    logServerError('invite-user', error)
    return fail(req, 500, 'internal_error')
  }
})

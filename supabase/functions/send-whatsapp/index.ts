// Internal WhatsApp sender used only by invite-user.
//
// There is deliberately no browser flow here. The function is deployed with
// verify_jwt = false so the platform does not require a user JWT, and it
// authenticates the internal caller with OTP_DELIVERY_SECRET instead. A
// browser cannot obtain that secret.
//
// Required function secrets:
//   OTP_DELIVERY_SECRET, SUPABASE_WHATSAPP_API_URL,
//   SUPABASE_WHATSAPP_API_KEY, SUPABASE_WHATSAPP_FROM_NUMBER
//
// Deploy with: supabase functions deploy send-whatsapp

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import {
  HttpError,
  fail,
  json,
  logServerError,
  normalizePhone,
  preflight,
  readJson,
  requireEnv,
  requirePost,
  timingSafeEqual,
} from '../_shared/http.ts'
import { deliverMessage, safeDisplayName } from '../_shared/delivery.ts'

const ALLOWED_ROLES = new Set(['manager', 'admin', 'coach'])

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight(req, false)

  try {
    requirePost(req)

    const expected = requireEnv('OTP_DELIVERY_SECRET')
    if (expected.length < 16) throw new HttpError(500, 'configuration_error')
    const provided = req.headers.get('x-internal-secret') ?? ''
    if (!provided || !timingSafeEqual(provided, expected)) {
      throw new HttpError(401, 'unauthorized')
    }

    const apiUrl = requireEnv('SUPABASE_WHATSAPP_API_URL')
    const apiKey = requireEnv('SUPABASE_WHATSAPP_API_KEY')
    const fromNumber = requireEnv('SUPABASE_WHATSAPP_FROM_NUMBER')

    const body = await readJson(req)
    const phone = normalizePhone(body.phone)
    const otpCode = typeof body.otp_code === 'string' ? body.otp_code.trim() : ''
    const role = typeof body.role === 'string' ? body.role : ''
    const fullName = safeDisplayName(body.full_name)

    if (!phone) throw new HttpError(400, 'invalid_phone')
    if (!/^[0-9]{6}$/.test(otpCode)) throw new HttpError(400, 'invalid_otp')
    if (!ALLOWED_ROLES.has(role)) throw new HttpError(400, 'invalid_role')

    const message = `THE TRAINERS invitation\n\n`
      + `Hello ${fullName},\n\n`
      + `You have been invited to join THE TRAINERS as ${role}.\n\n`
      + `Verification code: ${otpCode}\n\n`
      + `This code expires in 10 minutes. If you did not expect this invitation, ignore this message.`

    await deliverMessage({
      endpoint: apiUrl,
      apiKey,
      from: fromNumber,
      to: phone,
      body: message,
    })

    return json(req, { ok: true }, 200, false)
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 500) logServerError('send-whatsapp', error)
      return fail(req, error.status, error.code, false)
    }
    logServerError('send-whatsapp', error)
    return fail(req, 500, 'internal_error', false)
  }
})

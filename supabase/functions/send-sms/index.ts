// Internal SMS sender used only by invite-user.
//
// See send-whatsapp for the authentication model: no browser access, a shared
// OTP_DELIVERY_SECRET header, and no recipient or code in the response.
//
// Required function secrets:
//   OTP_DELIVERY_SECRET, SUPABASE_SMS_API_URL,
//   SUPABASE_SMS_API_KEY, SUPABASE_SMS_FROM_NUMBER
//
// Deploy with: supabase functions deploy send-sms

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
import { deliverMessage } from '../_shared/delivery.ts'

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

    const apiUrl = requireEnv('SUPABASE_SMS_API_URL')
    const apiKey = requireEnv('SUPABASE_SMS_API_KEY')
    const fromNumber = requireEnv('SUPABASE_SMS_FROM_NUMBER')

    const body = await readJson(req)
    const phone = normalizePhone(body.phone)
    const otpCode = typeof body.otp_code === 'string' ? body.otp_code.trim() : ''

    if (!phone) throw new HttpError(400, 'invalid_phone')
    if (!/^[0-9]{6}$/.test(otpCode)) throw new HttpError(400, 'invalid_otp')

    const message = `THE TRAINERS: invitation code ${otpCode}. Valid for 10 minutes. If unexpected, ignore.`

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
      if (error.status >= 500) logServerError('send-sms', error)
      return fail(req, error.status, error.code, false)
    }
    logServerError('send-sms', error)
    return fail(req, 500, 'internal_error', false)
  }
})

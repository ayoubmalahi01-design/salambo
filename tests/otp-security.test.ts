// Static security tests for the invitation/OTP repair.
//
// These tests do not run PostgreSQL, Supabase or a messaging provider. They pin
// the properties that can be checked from the repository: hashes instead of
// plaintext, one live code per invitation, service-role-only RPCs, no wildcard
// CORS, no OTP in responses or logs, and invitee-side redemption from the
// authenticated session rather than a browser-supplied invitation id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ORIGINS,
  isEmail,
  isUuid,
  normalizePhone,
  timingSafeEqual,
} from '../supabase/functions/_shared/http.ts'
import { dict, LANGS } from '../src/lib/i18n.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const migration = read('supabase/INVITATIONS_OTP_INCREMENTAL.sql')
const app = read('src/App.tsx')
const invite = read('supabase/functions/invite-user/index.ts')
const verify = read('supabase/functions/verify-otp/index.ts')
const whatsapp = read('supabase/functions/send-whatsapp/index.ts')
const sms = read('supabase/functions/send-sms/index.ts')
const shared = read('supabase/functions/_shared/http.ts')
const config = read('supabase/config.toml')
const envExample = read('.env.example')

/** Extract every `json(req, { ... })` object literal from a function. */
function jsonResponseBodies(source: string): string[] {
  const bodies: string[] = []
  const marker = /json\s*\(\s*req\s*,\s*\{/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(source)) !== null) {
    let index = marker.lastIndex - 1
    let depth = 0
    let end = index
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      if (source[end] === '}') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    bodies.push(source.slice(index, end))
  }
  return bodies
}

test('shared helpers reject malformed phones, emails and UUIDs', () => {
  assert.equal(normalizePhone('+212 600-000000'), '+212600000000')
  assert.equal(normalizePhone('00212600000000'), '+212600000000')
  assert.equal(normalizePhone('06 00 00 00 00'), '')
  assert.equal(normalizePhone(212600000000), '')

  assert.equal(isEmail('coach@example.com'), true)
  assert.equal(isEmail('coach@example'), false)
  assert.equal(isEmail('a b@example.com'), false)
  assert.equal(isEmail('x'.repeat(250) + '@example.com'), false)

  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isUuid('not-a-uuid'), false)
})

test('secret comparison does not depend on where the first difference is', () => {
  assert.equal(timingSafeEqual('correct-horse-battery', 'correct-horse-battery'), true)
  assert.equal(timingSafeEqual('correct-horse-battery', 'correct-horse-batterz'), false)
  assert.equal(timingSafeEqual('short', 'a much longer secret value'), false)
  assert.equal(timingSafeEqual('', ''), true)
})

test('development origins are explicit, never a wildcard', () => {
  assert.ok(DEFAULT_ORIGINS.length > 0)
  assert.ok(DEFAULT_ORIGINS.every((origin) => origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')))
  assert.ok(!DEFAULT_ORIGINS.includes('*'))
})

test('the incremental migration has no workspace ROWTYPE declaration', () => {
  assert.equal(/%rowtype/i.test(migration), false)
})

test('the migration is transactional and never drops or truncates app data', () => {
  assert.match(migration, /^\s*begin\s*;/im)
  assert.match(migration, /^\s*commit\s*;/im)
  assert.doesNotMatch(migration, /drop\s+table\s+(if\s+exists\s+)?public\./i)
  assert.doesNotMatch(migration, /truncate\s+(table\s+)?public\./i)
})

test('OTP storage is hashed, never a plaintext column', () => {
  assert.match(migration, /code_hash/)
  assert.match(migration, /digest\s*\(\s*v_code\s*,\s*'sha256'\s*\)/i)
  assert.match(migration, /otp_codes_no_plaintext_check/)
  assert.match(migration, /set\s+code\s*=\s*null/i)
  assert.doesNotMatch(migration, /insert\s+into\s+public\.otp_codes\s*\([^)]*\bcode\b[^)]*\)/i)
})

test('OTP generation uses pgcrypto randomness, not random()', () => {
  assert.match(migration, /gen_random_bytes\s*\(/)
  assert.doesNotMatch(migration, /random\s*\(\s*\)\s*\*\s*900000/i)
})

test('only one live OTP can exist per invitation', () => {
  const cleanup = migration.indexOf('row_number() OVER')
  const index = migration.indexOf('otp_codes_one_live_per_invitation')
  assert.ok(cleanup > 0, 'duplicate live codes must be revoked first')
  assert.ok(index > cleanup, 'the unique index must be created after the cleanup')
  assert.match(migration, /CREATE UNIQUE INDEX otp_codes_one_live_per_invitation[\s\S]*?used_at IS NULL[\s\S]*?revoked_at IS NULL/i)
})

test('verification consumes the code and locks the invitation row', () => {
  assert.match(migration, /verify_otp_code[\s\S]*?FOR UPDATE/i)
  assert.match(migration, /set\s+used_at\s*=\s*now\(\)/i)
  assert.match(migration, /revoked_at\s*=\s*now\(\)/)
  assert.match(migration, /too_many_attempts/)
})

test('OTP RPCs are executable only by service_role', () => {
  const signatures = [
    'generate_otp_code(uuid, uuid)',
    'verify_otp_code(uuid, text, uuid)',
    'revoke_otp_code(uuid, text)',
    'get_otp_statistics()',
    'expire_stale_invitations()',
  ]
  for (const signature of signatures) {
    assert.ok(
      migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM anon, authenticated`),
      `${signature} must be revoked from browser roles`,
    )
    assert.ok(
      migration.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`),
      `${signature} must be granted to service_role`,
    )
  }
  assert.doesNotMatch(
    migration,
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(generate_otp_code|verify_otp_code|revoke_otp_code|get_otp_statistics|expire_stale_invitations)[^;]*TO[^;]*authenticated/i,
  )
})

test('verification never returns the hash or the code', () => {
  const start = migration.indexOf('CREATE FUNCTION public.verify_otp_code')
  const end = migration.indexOf('COMMENT ON FUNCTION public.verify_otp_code')
  assert.ok(start > 0 && end > start)
  const body = migration.slice(start, end)
  assert.doesNotMatch(body, /'code_hash'/)
  assert.doesNotMatch(body, /'otp_code'/)
})

test('the owner role is always rejected by the invitation flow', () => {
  assert.match(migration, /owner_invitation_forbidden/)
  assert.match(migration, /owner_role_forbidden/)
  assert.match(migration, /role\s*=\s*'coach'[\s\S]*?role::text\s*=\s*'owner'/i)
})

test('Edge Functions never emit wildcard CORS', () => {
  for (const source of [invite, verify, whatsapp, sms, shared]) {
    assert.doesNotMatch(source, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/)
  }
  assert.match(shared, /allowedOrigins\(\)\.includes/)
})

test('no function response contains an OTP or its hash', () => {
  const bodies = [invite, verify, whatsapp, sms].flatMap(jsonResponseBodies)
  assert.ok(bodies.length >= 4)
  for (const body of bodies) {
    assert.doesNotMatch(body, /otp_code|code_hash|otp\s*:/)
  }
})

test('invite-user keeps the email path and never returns the code', () => {
  assert.match(invite, /inviteUserByEmail/)
  assert.match(invite, /use_otp/)
  assert.match(invite, /message: 'otp_sent'/)
  assert.doesNotMatch(invite, /json\(req,\s*\{[^}]*otp_code/s)
})

test('verify-otp derives the invitation from the signed-in account', () => {
  assert.match(verify, /auth\.getUser\(\)/)
  assert.match(verify, /\.eq\('invited_email', email\)/)
  assert.match(verify, /sha256Hex\(code\)/)
  assert.doesNotMatch(verify, /body\.invitation_id|body\['invitation_id'\]/)
  assert.match(verify, /p_otp_code: code/)
  assert.match(verify, /message: 'invitation_accepted'/)
})

test('internal senders authenticate with a shared secret, not a browser JWT', () => {
  for (const source of [whatsapp, sms]) {
    assert.match(source, /x-internal-secret/)
    assert.match(source, /timingSafeEqual/)
    assert.match(source, /OTP_DELIVERY_SECRET/)
    assert.match(source, /preflight\(req, false\)/)
    assert.doesNotMatch(source, /Authorization/)
  }
  assert.match(invite, /'x-internal-secret': deliverySecret/)
})

test('JWT settings match the intended callers', () => {
  assert.match(config, /\[functions\.invite-user\][\s\S]*?verify_jwt\s*=\s*true/)
  assert.match(config, /\[functions\.verify-otp\][\s\S]*?verify_jwt\s*=\s*true/)
  assert.match(config, /\[functions\.send-whatsapp\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.send-sms\][\s\S]*?verify_jwt\s*=\s*false/)
})

test('the invitee redeems the code from their own session', () => {
  assert.match(app, /functions\.invoke\('verify-otp',\s*\{\s*body:\s*\{\s*otp_code:\s*code\s*\}/)
  assert.doesNotMatch(app, /invoke\('verify-otp'[^)]*invitation_id/s)
  assert.match(app, /function OtpCodeForm/)
  assert.match(app, /path="\/accept-invitation"/)
  assert.doesNotMatch(app, /otpVerificationOpen|pendingInvitationId/)
})

test('the role matrix cannot produce an owner', () => {
  assert.match(invite, /owner:\s*\['manager',\s*'admin',\s*'coach'\]/)
  assert.match(invite, /manager:\s*\['admin',\s*'coach'\]/)
  assert.match(invite, /admin:\s*\[\]/)
  assert.match(invite, /coach:\s*\[\]/)
  assert.match(invite, /role === 'owner'/)
})

test('OTP acceptance does not auto-activate a new account', () => {
  const start = migration.indexOf('UPDATE public.profiles')
  const end = migration.indexOf('WHERE id = p_user_id;', start)
  const body = migration.slice(start, end)
  assert.match(body, /ELSE 'pending'/)
  assert.doesNotMatch(body, /approved_by = COALESCE\(v_inviter_id/)
  assert.doesNotMatch(migration, /invitation_accepted[\s\S]{0,400}account_status', 'active'/)
})

test('public configuration examples contain placeholders only', () => {
  assert.match(envExample, /YOUR_PROJECT_REF/)
  assert.match(envExample, /YOUR_ANON_OR_PUBLISHABLE_KEY/)
  assert.doesNotMatch(envExample, /https:\/\/[a-z0-9]{15,}\.supabase\.co/i)
  assert.doesNotMatch(envExample, /sb_publishable_[A-Za-z0-9_-]{10,}/)
  assert.doesNotMatch(envExample, /SERVICE_ROLE_KEY/)
})

test('every new OTP message exists in all three languages', () => {
  const keys = [
    'otpCode',
    'otpTooMany',
    'otpExpired',
    'otpRecipientMismatch',
    'otpNotPending',
    'otpDifferentInstitution',
    'otpEmailRequired',
    'acceptInvitation',
    'acceptInvitationTitle',
    'acceptInvitationHint',
    'alreadyRegistered',
    'invalidPhone',
    'inviteDeliveryFailed',
    'tooManyRequests',
  ] as const
  for (const lang of LANGS) {
    for (const key of keys) {
      const value = (dict[lang] as Record<string, string | undefined>)[key]
      assert.equal(typeof value, 'string', `${lang}.${key} is missing`)
      assert.ok(value && value.trim().length > 0, `${lang}.${key} is empty`)
    }
  }
})

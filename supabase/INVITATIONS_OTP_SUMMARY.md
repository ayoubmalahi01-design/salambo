# THE TRAINERS — Invitations + OTP

This document describes the repaired invitation system. It replaces the earlier
summary that described the broken draft.

## Status and scope

- The SQL has been reviewed statically and is covered by repository tests, but it
  has **not** been executed against a live Supabase/PostgreSQL instance by this
  repair. Run it in staging first and keep a database backup.
- WhatsApp and SMS delivery cannot be tested without provider credentials. The
  Edge Functions fail closed with a stable error code when a provider is not
  configured.
- Email confirmation must stay **OFF** in Supabase Auth. The application relies on
  invitation/setup links and must not require a second confirmation mail.

## Installation order

1. Run `supabase/THE_TRAINERS_SETUP.sql` on a new project.
2. Run `supabase/INVITATIONS_OTP_INCREMENTAL.sql` once in the SQL Editor.
3. Deploy the four Edge Functions (see below).
4. Configure Auth **Confirm email = OFF**.
5. Create the platform owner account and invite the first institution manager.

The incremental file is one transaction (`begin` … `commit`). It is additive:

- it does not drop an application table or truncate business data;
- it does not contain `%ROWTYPE` (the original syntax error);
- it reconciles tables created by the earlier broken draft, including a legacy
  plaintext `code` column, old status/role checks and recipient unique
  constraints;
- it revokes duplicate live OTP rows before creating the one-live-code index;
- legacy rows are preserved, with `NOT VALID` constraints where appropriate.

## Schema

| Object | Purpose |
|--------|---------|
| `public.invitations` | One row per invitation, including inviter, institution, role, recipient, delivery method and status. |
| `public.otp_codes` | SHA-256 hashes of OTPs, binding, expiry, attempt count, use/revoke timestamps. |
| `public.otp_delivery_method` | `email`, `whatsapp`, `sms`. |
| `public.otp_purpose` | `invitation`, `password_reset`. |
| `public.otp_status` | Kept for compatibility: `pending`, `verified`, `expired`, `revoked`. |

### Client access

- `authenticated` may `SELECT` invitations for its own institution when the
  caller is a platform owner or a manager/admin. Writes are service-role only.
- `otp_codes` has no browser grant and no permissive RLS policy. Only the Edge
  Functions using the service-role key can read or write it.
- `anon` has no access to either table.

## RPCs (service-role only)

All functions are `SECURITY DEFINER` with a fixed `search_path`, revoked from
`PUBLIC`, `anon` and `authenticated`, and granted only to `service_role`.

| Function | Behaviour |
|----------|-----------|
| `generate_otp_code(p_invitation_id uuid, p_created_by uuid default null)` | Locks the invitation, validates binding/expiry/role, throttles issuance, revokes previous live codes, generates a cryptographically random 6-digit code with `gen_random_bytes`, stores only its SHA-256 hash, and returns `(otp_id, otp_code, expires_at)` once. |
| `verify_otp_code(p_invitation_id uuid, p_otp_code text, p_user_id uuid)` | Locks invitation and OTP rows, checks recipient/profile, institution, role, method, expiry and attempts, compares hashes, consumes the code, accepts the invitation, activates/updates the profile and writes the audit row atomically. Returns JSON with `ok`, `already_accepted`, `role`, `institution_id` or a stable error code. |
| `revoke_otp_code(p_invitation_id uuid, p_reason text)` | Revokes live codes and marks a pending invitation revoked. |
| `get_otp_statistics()` | Aggregate monitoring counts only; no codes or recipients. |
| `expire_stale_invitations()` | Marks expired pending invitations and revokes expired codes. |

## Invitation and OTP rules

| Rule | Value |
|------|-------|
| Invitation lifetime | 7 days |
| OTP lifetime | 10 minutes |
| OTP format | Exactly 6 digits |
| OTP storage | `encode(digest(code, 'sha256'), 'hex')` |
| OTP attempts | 5 per live code, then revoked |
| OTP single use | `used_at` set on success; siblings revoked |
| Codes per invitation | 5 per 15 minutes |
| Codes per inviter | 30 per 15 minutes |
| Invitations per inviter | 20 per 15 minutes (Edge Function) |
| Owner invitations | Always rejected by SQL and by the Edge Function |

A new code revokes every live code for the same invitation. A partial unique
index enforces one live code per invitation. `verify_otp_code` uses
`SELECT … FOR UPDATE`, so two concurrent requests cannot both succeed.

## Role matrix

| Caller | May invite |
|--------|------------|
| `owner` | `manager`, `admin`, `coach` |
| `manager` | `admin`, `coach` |
| `admin` | `coach` |
| `coach` | `coach` |

No flow can create an `owner`. The Edge Function also rejects an existing owner
profile and a caller without an active profile.

## Delivery flows

### Email (unchanged, backward compatible)

- `delivery_method: "email"`, `use_otp: false` or omitted.
- The function calls `auth.admin.inviteUserByEmail`, writes the pending profile
  and leaves activation to an institution administrator.
- The existing Supabase invitation email remains the account setup channel.

### WhatsApp / SMS

- The invitee is still identified by email; the phone is the delivery channel.
- A new auth account receives the normal Supabase setup email. The six-digit
  code proves control of the phone number and is redeemed **after sign-in**.
- The inviter never sees or enters the code. The invitee enters it on the
  pending-account screen or on `/accept-invitation`.
- The browser sends only `{ "otp_code": "123456" }` to `verify-otp`. The server
  derives candidate invitations from the signed-in email; no invitation id,
  institution or role is accepted from the browser.

A successful verification activates the profile, updates its role/institution,
records `accepted_by`/`accepted_at` and writes an audit entry. Retrying after a
successful acceptance returns `already_accepted` for the same account.

## Edge Functions and secrets

| Function | JWT verification | Caller |
|----------|------------------|--------|
| `invite-user` | `true` | Signed-in owner/manager/admin/coach |
| `verify-otp` | `true` | Signed-in invitee |
| `send-whatsapp` | `false` | `invite-user` only, authenticated by `x-internal-secret` |
| `send-sms` | `false` | `invite-user` only, authenticated by `x-internal-secret` |

Required function secrets:

```text
SUPABASE_SERVICE_ROLE_KEY
OTP_DELIVERY_SECRET            # at least 16 characters; shared by invite-user and senders
APP_URL                        # e.g. https://your-domain.example
ALLOWED_ORIGINS                # comma-separated browser origins
SUPABASE_WHATSAPP_API_URL
SUPABASE_WHATSAPP_API_KEY
SUPABASE_WHATSAPP_FROM_NUMBER
SUPABASE_SMS_API_URL
SUPABASE_SMS_API_KEY
SUPABASE_SMS_FROM_NUMBER
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided by the Supabase runtime.

Deploy:

```bash
npx supabase functions deploy invite-user
npx supabase functions deploy verify-otp
npx supabase functions deploy send-whatsapp
npx supabase functions deploy send-sms
```

## Security properties

- No plaintext OTP column is written by the new flow. The legacy `code` column,
  if present, is cleared and constrained to `NULL`.
- No OTP or hash is returned in an HTTP response other than the single
  server-to-server `generate_otp_code` result used to compose the message.
- No recipient number or OTP is written to logs. Server errors log only a scope
  and a bounded message/code.
- No wildcard CORS. Origins are reflected only when listed in
  `ALLOWED_ORIGINS`/`APP_URL`; internal senders never emit browser CORS.
- Internal sender secrets are compared with a length-independent loop.
- Request bodies are bounded to 32 KiB before parsing.
- The browser never holds a service-role key.
- Institution isolation and the existing RLS policies/triggers are preserved.

## Verification performed

```bash
node --import tsx --test tests/*.test.ts   # 75 tests, including tests/otp-security.test.ts
node scripts/verify-project.mjs           # 60 structural/security checks
node_modules/.bin/tsc.cmd --noEmit -p tsconfig.json
node_modules/.bin/vite.cmd build
```

The checks are static/unit checks. They are not a substitute for running the
migration against PostgreSQL, testing RLS with real JWTs, or sending a real
WhatsApp/SMS message.

## Known pre-deployment checks

1. Run the migration in staging and inspect `invitations`, `otp_codes`,
   constraints and grants.
2. Confirm Auth **Confirm email** is OFF.
3. Set every secret above; a missing provider secret returns
   `otp_delivery_failed`, not a partial invitation.
4. Test one email invitation, one WhatsApp invitation and one SMS invitation
   with real accounts you control.
5. Verify that a wrong code decrements attempts, that the sixth attempt is
   blocked, and that a used code cannot be replayed.

# 05 — Edge Functions

## Deployment status (probed via REST)
All four functions return `404 "Requested function was not found"` for both GET and POST:

| Function | Status | Notes |
|---|---|---|
| `invite-user` | 404 | JWT-protected (`verify_jwt = true`). Invitation creation + OTP delivery. |
| `verify-otp` | 404 | JWT-protected. OTP verification + account linking. |
| `send-whatsapp` | 404 | Internal only (`verify_jwt = false`), called by invite-user with `x-internal-secret`. |
| `send-sms` | 404 | Internal only (`verify_jwt = false`). |

**Conclusion: none of the Edge Functions are deployed to project `rxkyryaplszuklagvidi`.**

## Impact
- The entire account invitation flow is non-functional: inviting managers/admins/coaches, OTP delivery (WhatsApp/SMS), and OTP verification cannot work.
- `account-policy.ts` and the client UI reference these functions (`supabase.functions.invoke('invite-user'/'verify-otp')`).
- Tests in `tests/*.test.ts` validate the *logic* and *policy* of these functions (Edge Function matrix, OTP acceptance, etc.) but not the live deployment.

## Local function source (in repo)
- `supabase/functions/invite-user/index.ts` (19.5 KB)
- `supabase/functions/verify-otp/index.ts` (7.9 KB)
- `supabase/functions/send-whatsapp/index.ts` (2.8 KB)
- `supabase/functions/send-sms/index.ts` (2.2 KB)
- `supabase/functions/_shared/delivery.ts`, `http.ts`
- `supabase/config.toml`: declares `verify_jwt` per function (invite-user & verify-otp = true; send-whatsapp & send-sms = false).

## Required actions (manual, require approval)
1. Deploy all four functions: `supabase functions deploy invite-user verify-otp send-whatsapp send-sms` (requires Supabase CLI + project link + approval).
2. Set secrets: `OTP_DELIVERY_SECRET` (shared between invite-user and the delivery functions), plus any WhatsApp/SMS provider credentials.
3. Confirm `config.toml` `verify_jwt` settings are applied after deploy.
4. Test the full invite → OTP → accept flow end-to-end after deployment.

No functions were deployed during this audit.

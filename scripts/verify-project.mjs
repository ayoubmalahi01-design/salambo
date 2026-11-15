import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const required = [
  'src/App.tsx',
  'src/styles.css',
  'src/lib/supabase.ts',
  'src/lib/i18n.ts',
  'src/lib/account-policy.ts',
  'src/lib/account-gate.ts',
  'tests/otp-security.test.ts',
  'tests/account-policy.test.ts',
  'tests/account-permissions.test.ts',
  'supabase/THE_TRAINERS_SETUP.sql',
  'supabase/INVITATIONS_OTP_INCREMENTAL.sql',
  'supabase/migrations/0003_account_management_repair.sql',
  'supabase/functions/invite-user/index.ts',
  'supabase/functions/verify-otp/index.ts',
  'supabase/functions/send-whatsapp/index.ts',
  'supabase/functions/send-sms/index.ts',
  'supabase/functions/_shared/http.ts',
  'supabase/config.toml',
  'public/manifest.webmanifest',
  'public/sw.js',
  'README.md',
  'cloudflare/DEPLOYMENT.md',
  '.gitignore',
  'wrangler.toml',
  '.env.example',
]

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)))
if (missing.length) {
  console.error('Missing required files:', missing.join(', '))
  process.exit(1)
}

const sql = read('supabase/THE_TRAINERS_SETUP.sql')
const migration = read('supabase/INVITATIONS_OTP_INCREMENTAL.sql')
const repair = read('supabase/migrations/0003_account_management_repair.sql')
const policy = read('src/lib/account-policy.ts')
const app = read('src/App.tsx')
const envExample = read('.env.example')
const config = read('supabase/config.toml')
const invite = read('supabase/functions/invite-user/index.ts')
const verify = read('supabase/functions/verify-otp/index.ts')
const whatsapp = read('supabase/functions/send-whatsapp/index.ts')
const sms = read('supabase/functions/send-sms/index.ts')
const shared = read('supabase/functions/_shared/http.ts')
const verifyScript = fs.existsSync(path.join(root, 'verify_supabase.mjs'))
  ? read('verify_supabase.mjs')
  : ''

/**
 * Extract every `json(req, { ... })` object literal from a function. Used to
 * prove that no response body contains an OTP or its hash.
 */
function jsonResponseBodies(source) {
  const bodies = []
  const marker = /json\s*\(\s*req\s*,\s*\{/g
  let match
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

/** Source between two markers, for checking one component at a time. */
function between(source, start, end) {
  const from = source.indexOf(start)
  if (from < 0) return ''
  const to = source.indexOf(end, from)
  return to > from ? source.slice(from, to) : ''
}

const responseBodies = [invite, verify, whatsapp, sms].flatMap(jsonResponseBodies)
const edgeFunctions = [invite, verify, whatsapp, sms, shared]
const otpFunctions = [
  'generate_otp_code(uuid, uuid)',
  'verify_otp_code(uuid, text, uuid)',
  'revoke_otp_code(uuid, text)',
  'get_otp_statistics()',
  'expire_stale_invitations()',
]

const checks = [
  // ---------------------------------------------------------------- existing app
  ['absence follow-up flag', /track_absence_followup/.test(sql) && /absence_followups/.test(sql)],
  ['message read receipts', /mark_conversation_read/.test(sql) && /unread_counts/.test(sql)],
  ['rejected account status', /'rejected'/.test(sql)],
  ['env key name consistent', /VITE_SUPABASE_ANON_KEY/.test(envExample)],
  ['platform owner role', /create\s+type\s+public\.app_role\s+as\s+enum\s*\([^)]*'owner'/is.test(sql)],
  ['coach-private notebook RLS', /coach_notebooks[\s\S]*?coach_id=auth\.uid\(\)/i.test(sql)],
  ['coach report privacy RLS', /reports_read_own_admin[\s\S]*?coach_id=auth\.uid\(\)/i.test(sql)],
  ['medical records admin-only RLS', /medical_admin_read[\s\S]*?is_institution_admin\(\)/i.test(sql)],
  ['medical media private bucket', /trainer_medical_admin_read[\s\S]*?trainer-medical/i.test(sql)],
  ['private notebook excluded from audit snapshots', !/coach_notebooks.*_audit/.test(sql)],
  ['institution isolation', /current_institution_id\(\)/i.test(sql)],
  ['owner email bootstrap', /ayoubmalleh772@gmail\.com/i.test(sql)],
  ['self-promotion guard', /guard_profile_privileges[\s\S]*?cannot change your own role/i.test(sql)],
  ['final report immutability', /lock_final_report[\s\S]*?Finalized reports are immutable/i.test(sql)],
  ['notice notifications', /notify_new_notice[\s\S]*?insert into public\.notifications/i.test(sql)],
  ['edge invite function', /inviteUserByEmail/.test(invite)],
  ['attendance workflow', /function Attendance\(/.test(app)],
  ['private notebook UI', /function Notebook\(/.test(app)],
  ['team invitation UI', /function Team\(/.test(app)],
  ['media upload and audio capture', /MediaRecorder/.test(app) && /storage\.from\('trainer-media'\)\.upload/.test(app)],
  ['bulk Excel/CSV student import', /parseStudentPaste/.test(app) && /importBulk/.test(app)],
  ['direct and group conversation creation', /create_conversation/.test(app) && /conversation_type/.test(app)],
  ['conversation-scoped message reads and writes', /eq\('conversation_id',id\)/.test(app) && /conversation_id:current\.id/.test(app)],
  ['conversation membership enforced for messages', /messages_read_member[\s\S]*?is_conversation_member\(conversation_id\)/i.test(sql) && /messages_insert_member[\s\S]*?is_conversation_member\(conversation_id\)/i.test(sql)],
  ['private conversation media storage', /trainer_media_read[\s\S]*?is_conversation_member\(m\.conversation_id\)/i.test(sql)],
  ['automatic report counts from attendance', /attendance_records[\s\S]*?present_count/.test(app)],
  ['admin report review workflow', /reports_admin_review/.test(sql) && /reviewed_by/.test(app)],
  ['owner and director only can invite', /admin:\s*\[\]/.test(policy) && /coach:\s*\[\]/.test(policy) && /manager:\s*\['admin',\s*'coach'\]/.test(policy)],
  ['administration and coach cannot invite', /admin:\s*\[\]/.test(invite) && /coach:\s*\[\]/.test(invite) && !/Coaches may invite coaches only/.test(invite)],
  ['account review uses atomic RPC', /review_account/.test(repair) && /reviewAccount\(person\.id, action\)/.test(app)],
  ['team screen no longer writes profiles directly', !between(app, 'function Team', 'function Medical').includes("profiles').update")],
  ['administration team screen is read-only', /readOnlyAccounts/.test(app) && /canReviewAccount\(/.test(app)],
  ['messages screen no longer invites coaches', !between(app, 'function Messages', 'function OwnerConsole').includes('invite-user') && !between(app, 'function Messages', 'function OwnerConsole').includes('inviteCoach')],
  ['owner console can sync orphan profiles', /sync_missing_profiles/.test(repair) && /sync_missing_profiles/.test(app)],
  ['pending gate only offers a live invitation OTP', /my_pending_invitation/.test(repair) && /my_pending_invitation/.test(app)],
  ['edge-unreachable errors are mapped', /FunctionsFetchError/.test(app) && /edge_unreachable/.test(app)],

  // ------------------------------------------------------- migration integrity
  ['incremental migration avoids ROWTYPE', !/%rowtype/i.test(migration)],
  ['incremental migration is one transaction', /^\s*begin\s*;/im.test(migration) && /^\s*commit\s*;/im.test(migration)],
  ['migration never drops an application table', !/drop\s+table\s+(if\s+exists\s+)?public\./i.test(migration)],
  ['migration never truncates business data', !/truncate\s+(table\s+)?public\./i.test(migration)],
  ['hashed OTP column has no plaintext value', /otp_codes_no_plaintext_check/.test(migration) && /SET\s+code\s*=\s*NULL/i.test(migration)],
  ['OTP uses pgcrypto randomness', /gen_random_bytes\s*\(/.test(migration) && /digest\s*\([^)]*sha256/i.test(migration)],
  ['OTP is single-use and attempt-limited', /SET\s+used_at\s*=\s*now\(\)/i.test(migration) && /max_attempts/i.test(migration) && /too_many_attempts/.test(migration)],
  ['OTP verification locks the invitation row', /verify_otp_code[\s\S]*?FOR UPDATE/i.test(migration)],
  ['duplicate live codes are revoked before the unique index', /row_number\(\)\s+OVER[\s\S]*?otp_codes_one_live_per_invitation/i.test(migration)],
  ['owner can never be invited or activated', /owner_invitation_forbidden/.test(migration) && /owner_role_forbidden/.test(migration)],
  ['every OTP RPC is revoked from browser roles', otpFunctions.every((signature) => migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM anon, authenticated`))],
  ['every OTP RPC is granted only to service_role', otpFunctions.every((signature) => migration.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`))],
  ['no OTP RPC is granted to authenticated', !/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(generate_otp_code|verify_otp_code|revoke_otp_code|get_otp_statistics|expire_stale_invitations)[^;]*TO[^;]*authenticated/i.test(migration)],
  ['invitations and OTP rows are hidden from browser roles', /REVOKE ALL ON TABLE public\.invitations FROM anon, authenticated/.test(migration) && /REVOKE ALL ON TABLE public\.otp_codes FROM anon, authenticated/.test(migration)],
  ['invitation RLS excludes administration and coach', /CREATE POLICY invitations_select_admin[\s\S]*?current_app_role\(\) = 'manager'[\s\S]*?\);/.test(migration) && !/CREATE POLICY invitations_select_admin[\s\S]*?current_app_role\(\) IN \('manager', 'admin'\)/.test(migration)],
  ['OTP acceptance leaves new accounts pending', /WHEN v_profile_status = 'active'[\s\S]*?ELSE 'pending'/.test(migration)],
  ['profile update RLS is owner/director only', /create policy profiles_admin_update[\s\S]*?current_app_role\(\)='manager'[\s\S]*?role in \('admin','coach'\)/.test(sql)],
  ['owner sees the full audit log', /create policy audit_read_admin[\s\S]*?is_platform_owner\(\)[\s\S]*?\);/.test(sql)],

  // ------------------------------------------------------- account repair migration
  ['repair migration is transactional and non-destructive', /^\s*begin\s*;/im.test(repair) && /^\s*commit\s*;/im.test(repair) && !/drop\s+table\s+(if\s+exists\s+)?public\./i.test(repair) && !/truncate\s+(table\s+)?public\./i.test(repair) && !/delete\s+from\s+public\./i.test(repair)],
  ['repair migration can run twice', /create or replace function public\.ensure_my_profile/i.test(repair) && /create or replace function public\.review_account/i.test(repair) && /drop policy if exists/i.test(repair)],
  ['repair migration adds all four account RPCs', ['ensure_my_profile()', 'sync_missing_profiles()', 'review_account(', 'my_pending_invitation()'].every((name) => repair.includes(name))],
  ['repair migration blocks self and owner review', /self_review_forbidden/.test(repair) && /owner_protected/.test(repair) && /owner_role_forbidden/.test(repair) && /role_change_forbidden/.test(repair)],
  ['repair migration patches legacy OTP auto-activation', /account_status = ''active''/.test(repair) && /execute v_def/.test(repair) && /still auto-activates accounts/.test(repair)],
  ['repair RPCs are not executable by anon', /revoke all on function public\.review_account[^;]*from public, anon/i.test(repair) && /revoke all on function public\.ensure_my_profile\(\) from public, anon/i.test(repair)],

  // ------------------------------------------------------- edge-function rules
  ['no wildcard CORS in Edge Functions', !edgeFunctions.some((source) => /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/.test(source))],
  ['CORS reflects only configured origins', /allowedOrigins\(\)[\s\S]*?includes/.test(shared)],
  ['no OTP or hash in any JSON response', !responseBodies.some((body) => /otp_code|code_hash|otp\s*:/.test(body))],
  ['invite-user never returns the code', /message: 'otp_sent'/.test(invite) && !/json\(req,\s*\{[^}]*otp_code/s.test(invite)],
  ['verify-otp returns only acceptance metadata', /message: 'invitation_accepted'/.test(verify) && !jsonResponseBodies(verify).some((body) => /otp_code|code_hash/.test(body))],
  ['internal senders require x-internal-secret', /x-internal-secret/.test(whatsapp) && /x-internal-secret/.test(sms) && /x-internal-secret/.test(shared)],
  ['internal senders compare secrets in constant time', /timingSafeEqual/.test(whatsapp) && /timingSafeEqual/.test(sms)],
  ['invite-user sends the secret internally', /'x-internal-secret': deliverySecret/.test(invite)],
  ['invite-user is JWT-protected', /\[functions\.invite-user\][\s\S]*?verify_jwt\s*=\s*true/.test(config)],
  ['verify-otp is JWT-protected', /\[functions\.verify-otp\][\s\S]*?verify_jwt\s*=\s*true/.test(config)],
  ['delivery functions do not require a browser JWT', /\[functions\.send-whatsapp\][\s\S]*?verify_jwt\s*=\s*false/.test(config) && /\[functions\.send-sms\][\s\S]*?verify_jwt\s*=\s*false/.test(config)],
  ['invitee, not inviter, redeems the code', /invoke\('verify-otp'[\s\S]{0,160}?body:\s*\{\s*otp_code:\s*code\s*\}/.test(app)],
  ['browser never chooses the invitation to redeem', !/invoke\('verify-otp'[\s\S]{0,300}?invitation_id/.test(app)],
  ['role matrix: owner may not invite owners', /owner:\s*\['manager',\s*'admin',\s*'coach'\]/.test(invite) && /manager:\s*\['admin',\s*'coach'\]/.test(invite) && /admin:\s*\[\]/.test(invite) && /coach:\s*\[\]/.test(invite)],
  ['email invitation flow is preserved', /inviteUserByEmail/.test(invite) && /use_otp/.test(invite)],

  // ----------------------------------------------------------- secret hygiene
  ['no service-role key in frontend', !/SUPABASE_SERVICE_ROLE_KEY|service_role_key|serviceRoleKey/.test(app) && !/SUPABASE_SERVICE_ROLE_KEY|service_role_key|serviceRoleKey/.test(read('src/lib/supabase.ts'))],
  ['env example contains placeholders only', /YOUR_PROJECT_REF/.test(envExample) && /YOUR_ANON_OR_PUBLISHABLE_KEY/.test(envExample) && !/https:\/\/[a-z0-9]{15,}\.supabase\.co/i.test(envExample) && !/sb_publishable_[A-Za-z0-9_-]{10,}/.test(envExample)],
  ['verification script has no hardcoded credentials', !/https:\/\/[a-z0-9]{15,}\.supabase\.co/i.test(verifyScript) && !/sb_publishable_[A-Za-z0-9_-]{10,}/.test(verifyScript)],
]

let failed = false
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed = true
}

if (failed) process.exit(1)
console.log(`Project structure verified (${required.length} required files, ${checks.length} checks). This is not a substitute for a real Supabase RLS integration test, PostgreSQL migration run, provider delivery test or device test.`)

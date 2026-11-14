// Static project checks (no database, no network). Run: npm run verify
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = (p) => readFileSync(join(root, p), 'utf8')
const problems = []
const check = (ok, msg) => { if (!ok) problems.push(msg) }

for (const f of [
  'index.html', 'package.json', 'src/App.tsx', 'src/styles.css', 'src/lib/i18n.ts', 'src/lib/supabase.ts',
  'public/manifest.webmanifest', 'public/sw.js', 'public/_headers', 'public/icons/icon-192.png',
  'public/icons/icon-512.png', 'public/icons/icon-maskable-512.png', 'supabase/THE_TRAINERS_SETUP.sql',
  'supabase/functions/invite-user/index.ts', '.env.example',
]) check(existsSync(join(root, f)), `missing file: ${f}`)

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name)
    statSync(join(root, rel)).isDirectory() ? walk(rel, out) : out.push(rel)
  }
  return out
}

// 1. The browser bundle must never reference the service_role key.
for (const f of walk('src')) check(!/service_role/i.test(read(f)), `${f} mentions service_role`)
check(!/SERVICE_ROLE/.test(read('.env.example')), '.env.example must not contain a service role key')

// 2. Every table created in the setup SQL has Row Level Security enabled.
const sql = read('supabase/THE_TRAINERS_SETUP.sql')
const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])
const loopTables = []
for (const m of sql.matchAll(/foreach t in array array\[([^\]]*)\]/gi)) {
  if (/enable row level security/i.test(sql.slice(m.index, m.index + m[0].length + 200))) {
    loopTables.push(...[...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))
  }
}
for (const t of tables) {
  const explicit = new RegExp(String.raw`alter table public\.${t}\s+enable row level security`, 'i').test(sql)
  check(explicit || loopTables.includes(t), `RLS not enabled for public.${t}`)
}

// 3. Every table the UI reads exists in the SQL.
const app = read('src/App.tsx') + read('src/lib/attendance.ts')
for (const t of new Set([...app.matchAll(/from\('([a-z_]+)'\)/g)].map((m) => m[1]))) {
  if (['trainer-media'].includes(t)) continue
  check(tables.includes(t), `UI queries unknown table: ${t}`)
}

// 4. Security headers and PWA basics.
const headers = read('public/_headers')
for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options']) check(headers.includes(h), `_headers lacks ${h}`)
const manifest = JSON.parse(read('public/manifest.webmanifest'))
check(manifest.display === 'standalone' && manifest.icons?.length >= 2, 'manifest.webmanifest incomplete')

if (problems.length) {
  console.error('verify: FAILED\n - ' + problems.join('\n - '))
  process.exit(1)
}
console.log(`verify: OK (${tables.length} tables with RLS, security headers present, no service_role in src)`)

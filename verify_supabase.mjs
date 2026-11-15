// Read-only connectivity probe. It uses the public anon/publishable key only.
//
// This file intentionally contains no project URL or key. Provide them through
// the environment or a local `.env.local` / `.env` file that is excluded from
// Git and from the deliverable archives:
//
//   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
//   VITE_SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
//
// Run with: node verify_supabase.mjs

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadLocalEnv() {
  for (const file of ['.env.local', '.env']) {
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      let value = match[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(match[1] in process.env)) process.env[match[1]] = value
    }
  }
}

loadLocalEnv()

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or the SUPABASE_* equivalents) first.')
  process.exit(1)
}

if (url.includes('YOUR_') || key.includes('YOUR_')) {
  console.error('Replace the placeholder Supabase values with your project values first.')
  process.exit(1)
}

const supa = createClient(url, key)

async function check() {
  const tables = ['profiles', 'institutions', 'students', 'attendance_records', 'daily_reports', 'student_notes', 'coach_notebooks', 'admin_notices', 'conversations', 'conversation_members', 'messages', 'notifications', 'audit_logs', 'student_medical_records', 'classes', 'coach_shifts', 'absence_followups', 'message_reads']

  for (const table of tables) {
    try {
      const { error, count } = await supa.from(table).select('*', { count: 'exact', head: true })
      console.log(table + ': count=' + count + ', error=' + (error?.message?.substring(0, 50) || 'none'))
    } catch (e) {
      console.log(table + ': exception - ' + e.message?.substring(0, 50))
    }
  }

  // Check attendance_records columns
  console.log('\n=== attendance_records ===')
  try {
    const { error: aError } = await supa.from('attendance_records').select('*').limit(0)
    console.log('empty: error=' + (aError?.message || 'none'))
    const { data: aData2, error: aError2 } = await supa.from('attendance_records').select('session_key').limit(1)
    console.log('select session_key: error=' + (aError2?.message || 'none') + ', data=' + (aData2?.length || 0))
  } catch (e) {
    console.log('exception: ' + e.message?.substring(0, 50))
  }

  // Check RPC functions
  console.log('\n=== RPC functions ===')
  const functions = ['current_institution_id', 'current_app_role', 'is_platform_owner', 'is_institution_admin', 'is_active_member', 'is_conversation_member', 'create_conversation', 'unread_counts', 'mark_conversation_read', 'mark_followup_handled']
  for (const fn of functions) {
    try {
      const { data, error } = await supa.rpc(fn, {})
      console.log(fn + ': error=' + (error?.message?.substring(0, 40) || 'success') + ', data=' + JSON.stringify(data).substring(0, 30))
    } catch (e) {
      console.log(fn + ': exception - ' + e.message?.substring(0, 40))
    }
  }
}

check()

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountGate, gateAllowsRetry } from '../src/lib/account-gate.ts'
import { buildAttendanceRows, friendlyAttendanceError, isMissingSessionColumn } from '../src/lib/attendance-core.ts'
import { dict } from '../src/lib/i18n.ts'

test('accountGate maps each account state to its own screen', () => {
  assert.equal(accountGate({ account_status: 'active' }), 'active')
  assert.equal(accountGate({ account_status: 'pending' }), 'pending')
  assert.equal(accountGate({ account_status: 'rejected' }), 'rejected')
  assert.equal(accountGate({ account_status: 'suspended' }), 'suspended')
  assert.equal(accountGate(null), 'missing')
  assert.equal(accountGate({ account_status: 'active' }, 'network'), 'error')
  assert.equal(gateAllowsRetry('error'), true)
  assert.equal(gateAllowsRetry('missing'), false)
})

test('buildAttendanceRows skips unset students, dedupes and nulls blank reasons', () => {
  const rows = buildAttendanceRows(
    [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }],
    { a: 'present', b: 'absent' },
    { b: '   ', a: ' sick ' },
    { institution_id: 'i1', coach_id: 'c1', session_date: '2026-11-14' },
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].reason, 'sick')
  assert.equal(rows[1].reason, null)
})

test('attendance error helpers', () => {
  assert.equal(isMissingSessionColumn({ code: '42703' }), true)
  assert.equal(isMissingSessionColumn({ message: 'column session_key does not exist' }), true)
  assert.equal(isMissingSessionColumn(null), false)
  assert.match(friendlyAttendanceError({ code: '23505' }), /already has/)
  assert.match(friendlyAttendanceError({ code: '42501' }), /not allowed/)
})

test('ar, fr and en dictionaries expose exactly the same keys', () => {
  const ar = Object.keys(dict.ar).sort()
  assert.deepEqual(Object.keys(dict.fr).sort(), ar)
  assert.deepEqual(Object.keys(dict.en).sort(), ar)
})

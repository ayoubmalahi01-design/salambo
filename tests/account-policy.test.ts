// Unit tests for the centralized account permission matrix.
//
// The UI, the Edge Function and the SQL RPCs each implement the same rules.
// These tests pin the browser module; `account-permissions.test.ts` compares
// the SQL and Edge Function copies against it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSIGNABLE_ROLES,
  INVITE_MATRIX,
  canInvite,
  canManageAccounts,
  canReviewAccount,
  isAccountRole,
} from '../src/lib/account-policy.ts'

const ROLES = ['owner', 'manager', 'admin', 'coach'] as const

test('only Owner and Director may invite anybody', () => {
  assert.deepEqual(INVITE_MATRIX.owner, ['manager', 'admin', 'coach'])
  assert.deepEqual(INVITE_MATRIX.manager, ['admin', 'coach'])
  assert.deepEqual(INVITE_MATRIX.admin, [])
  assert.deepEqual(INVITE_MATRIX.coach, [])
})

test('no role can invite or assign a second owner', () => {
  for (const role of ROLES) {
    assert.equal(INVITE_MATRIX[role].includes('owner'), false, `${role} must not invite an owner`)
  }
  assert.equal(ASSIGNABLE_ROLES.includes('owner'), false)
  assert.deepEqual(ASSIGNABLE_ROLES, ['manager', 'admin', 'coach'])
})

test('canInvite matches the matrix exactly', () => {
  for (const actor of ROLES) {
    for (const target of ROLES) {
      assert.equal(
        canInvite(actor, target),
        INVITE_MATRIX[actor].includes(target),
        `${actor} -> ${target}`,
      )
    }
  }
})

test('Administration and Coach cannot invite, approve or manage accounts', () => {
  for (const actor of ['admin', 'coach'] as const) {
    assert.equal(canManageAccounts(actor), false)
    for (const target of ROLES) {
      assert.equal(canInvite(actor, target), false, `${actor} must not invite ${target}`)
      assert.equal(
        canReviewAccount(actor, target, true),
        false,
        `${actor} must not review ${target}`,
      )
    }
  }
})

test('Owner reviews every non-owner account platform-wide', () => {
  assert.equal(canManageAccounts('owner'), true)
  for (const target of ['manager', 'admin', 'coach'] as const) {
    assert.equal(canReviewAccount('owner', target, false), true, `owner -> ${target}`)
    assert.equal(canReviewAccount('owner', target, true), true, `owner -> ${target}`)
  }
  assert.equal(canReviewAccount('owner', 'owner', false), false)
  assert.equal(canReviewAccount('owner', 'coach', true, true), false, 'owner cannot review self')
})

test('Director reviews only admin/coach accounts in the same institution', () => {
  assert.equal(canManageAccounts('manager'), true)
  assert.equal(canReviewAccount('manager', 'admin', true), true)
  assert.equal(canReviewAccount('manager', 'coach', true), true)
  assert.equal(canReviewAccount('manager', 'admin', false), false, 'other institution')
  assert.equal(canReviewAccount('manager', 'coach', false), false, 'other institution')
  assert.equal(canReviewAccount('manager', 'manager', true), false, 'cannot review peers')
  assert.equal(canReviewAccount('manager', 'owner', true), false, 'cannot review owner')
  assert.equal(canReviewAccount('manager', 'coach', true, true), false, 'cannot review self')
})

test('the owner account is never reviewable by anyone', () => {
  for (const actor of ROLES) {
    assert.equal(canReviewAccount(actor, 'owner', true), false, `${actor} must not review the owner`)
  }
})

test('role validation accepts only the four known roles', () => {
  for (const role of ROLES) assert.equal(isAccountRole(role), true)
  for (const value of ['', 'Owner', 'superadmin', null, undefined, 1, {}]) {
    assert.equal(isAccountRole(value), false)
  }
})

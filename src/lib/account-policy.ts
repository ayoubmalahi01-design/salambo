// Central account-policy rules shared by the UI and pinned by tests.
//
// The Edge Function carries the same matrix because Deno cannot import this
// browser module. `tests/account-permissions.test.ts` compares both copies.
export type AccountRole = 'owner' | 'manager' | 'admin' | 'coach'

export const INVITE_MATRIX: Record<AccountRole, AccountRole[]> = {
  owner: ['manager', 'admin', 'coach'],
  manager: ['admin', 'coach'],
  admin: [],
  coach: [],
}

export const ASSIGNABLE_ROLES: AccountRole[] = ['manager', 'admin', 'coach']

export function isAccountRole(value: unknown): value is AccountRole {
  return value === 'owner' || value === 'manager' || value === 'admin' || value === 'coach'
}

export function canInvite(actor: AccountRole, target: AccountRole): boolean {
  return INVITE_MATRIX[actor].includes(target)
}

/**
 * Reviewing an account is reserved to the platform owner and the institution
 * manager. A manager may only review admin/coach accounts in the same
 * institution. Nobody may review the owner account or their own account.
 */
export function canReviewAccount(
  actor: AccountRole,
  target: AccountRole,
  sameInstitution: boolean,
  isSelf = false,
): boolean {
  if (isSelf || target === 'owner') return false
  if (actor === 'owner') return true
  if (actor !== 'manager' || !sameInstitution) return false
  return target === 'admin' || target === 'coach'
}

export function canManageAccounts(role: AccountRole): boolean {
  return role === 'owner' || role === 'manager'
}

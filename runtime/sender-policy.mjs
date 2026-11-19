/**
 * Pure sender-admission policy for the WeChat ClawBot runtime.
 *
 * The default installation starts with no owner. The first unknown contact is
 * NOT trusted automatically: it becomes a pending owner request that the
 * authenticated DSH plugin page must approve. Allow-listed users configured in
 * `cordis.patch.yml` are trusted by the operator and may claim ownership on
 * their first message (an explicit administrative decision).
 *
 * Kept dependency-free so `node --test` can cover it without a running DSH.
 *
 * @module dsh-wechat-clawbot-access/runtime/sender-policy
 */

/** How long a pending owner request stays valid before another contact may request. */
export const PAIRING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Mask a WeChat contact id for logs (full ids stay in 0600 state/status files).
 * @param {unknown} id - raw contact id.
 * @returns {string} short, non-reversible-enough display form.
 */
export function maskId(id) {
  const text = String(id ?? '')
  if (!text) return ''
  if (text.length <= 8) return '***'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * Classify one inbound contact against the current ownership state.
 *
 * Actions:
 * - `owner`            — already the approved owner; proceed with replies.
 * - `allowed-new-owner`— sender is in the operator allow-list and no owner is
 *                        set yet; lock ownership to them and proceed.
 * - `pending-new`      — no owner/allow-list; register this sender as pending.
 * - `pending-remind`   — same sender as the pending request; remind (rate-limited).
 * - `deny`             — everyone else.
 *
 * @param {{fromId: string, ownerId?: string, allowedUsers?: string[],
 *   pendingOwner?: null|{id?: string, at?: number}, now?: number, ttlMs?: number}} input
 *   admission input.
 * @returns {{action: 'owner'|'allowed-new-owner'|'pending-new'|'pending-remind'|'deny',
 *   reason?: string}} decision.
 */
export function classifySender(input) {
  const fromId = typeof input?.fromId === 'string' ? input.fromId : ''
  if (!fromId) return { action: 'deny', reason: 'empty-id' }
  const ownerId = typeof input.ownerId === 'string' ? input.ownerId : ''
  const allowedUsers = Array.isArray(input.allowedUsers) ? input.allowedUsers : []
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now()
  const ttlMs = Number.isFinite(input?.ttlMs) ? Number(input.ttlMs) : PAIRING_TTL_MS

  if (ownerId) {
    return ownerId === fromId ? { action: 'owner' } : { action: 'deny', reason: 'not-owner' }
  }
  if (allowedUsers.length > 0) {
    return allowedUsers.includes(fromId)
      ? { action: 'allowed-new-owner' }
      : { action: 'deny', reason: 'not-allow-listed' }
  }

  const pending = input?.pendingOwner
  const pendingId = pending && typeof pending.id === 'string' ? pending.id : ''
  const pendingAt = pending && Number.isFinite(pending.at) ? Number(pending.at) : 0
  const pendingExpired = !pendingId || !pendingAt || now - pendingAt > ttlMs
  if (pendingExpired) return { action: 'pending-new' }
  if (pendingId === fromId) return { action: 'pending-remind' }
  return { action: 'deny', reason: 'pairing-pending-for-another-contact' }
}

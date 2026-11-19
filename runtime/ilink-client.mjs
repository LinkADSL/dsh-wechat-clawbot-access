/**
 * Minimal iLink HTTP client used by the ClawBot runtime.
 *
 * This module has no Harness or Agent dependency; it only speaks the official
 * WeChat ClawBot protocol and keeps the runtime class focused on lifecycle,
 * state and policy.
 *
 * @module dsh-wechat-clawbot-access/runtime/ilink-client
 */
import { DEFAULT_BASE_URL, chunkText, messageOf, randomId } from './common.mjs'

/** One ClawBot protocol failure with a machine-readable kind preserved. */
export class ClawbotError extends Error {
  /**
   * @param {string} message - readable description.
   * @param {string} code - error kind: auth|network|timeout|http|json|ret|aborted|config.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ClawbotError'
    this.code = code
  }
}

/** @param {unknown} value - text to shorten. @param {number} limit - maximum length. @returns {string} clipped text. */
export function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Call one iLink endpoint with protocol headers.
 * @param {object} input - request input.
 * @param {string} input.baseUrl - iLink base URL.
 * @param {string} input.token - bot token, or an empty string for login endpoints.
 * @param {string} input.pathname - endpoint path below the base URL.
 * @param {string} [input.method] - HTTP method (default POST).
 * @param {unknown} [input.body] - JSON body.
 * @param {number} [input.timeoutMs] - request timeout (default 30 s).
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @param {boolean} [input.auth] - attach the bot token (default true).
 * @returns {Promise<object>} parsed JSON response.
 */
export async function requestJson(input) {
  const {
    baseUrl,
    token,
    pathname,
    method = 'POST',
    body,
    timeoutMs = 30000,
    signal,
    auth = true,
  } = input
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal && !signal.aborted ? AbortSignal.any([signal, timeout]) : timeout
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64'),
  }
  if (auth && token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(`${base}/${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: composed,
    })
  } catch (error) {
    if (signal?.aborted) throw new ClawbotError('request aborted', 'aborted')
    if (timeout.aborted) throw new ClawbotError(`ClawBot ${pathname} timed out after ${timeoutMs}ms`, 'timeout')
    throw new ClawbotError(`ClawBot ${pathname} request failed: ${messageOf(error)}`, 'network')
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403
    throw new ClawbotError(
      `ClawBot ${pathname} returned HTTP ${response.status}: ${clip(raw, 240)}`,
      authFailure ? 'auth' : 'http',
    )
  }
  let parsed
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw new ClawbotError(`ClawBot ${pathname} returned invalid JSON: ${clip(raw, 240)}`, 'json')
  }
  if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
    const authFailure = parsed.errcode === -14 || /session timeout|token/i.test(String(parsed.errmsg ?? ''))
    throw new ClawbotError(
      `ClawBot ${pathname} failed: errcode=${parsed.errcode}${parsed.errmsg ? ` (${parsed.errmsg})` : ''}`,
      authFailure ? 'auth' : 'ret',
    )
  }
  if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
    throw new ClawbotError(
      `ClawBot ${pathname} failed with ret=${parsed.ret}${parsed.errmsg ? `: ${parsed.errmsg}` : ''}`,
      'ret',
    )
  }
  return parsed
}

/**
 * Send one text message, split into protocol-sized chunks.
 * @param {object} input - send input.
 * @param {string} input.baseUrl - iLink base URL.
 * @param {string} input.token - bot token.
 * @param {string} input.toUserId - recipient WeChat user id.
 * @param {string} input.contextToken - context token from that contact's latest message.
 * @param {string} input.text - message body.
 * @param {number} input.maxSendChars - maximum characters per chunk.
 * @param {string} input.channelVersion - iLink channel version.
 * @returns {Promise<void>}
 */
export async function sendText(input) {
  const { baseUrl, token, toUserId, contextToken, text, maxSendChars, channelVersion } = input
  if (!token) throw new ClawbotError('WeChat is not logged in', 'auth')
  if (!contextToken) throw new ClawbotError(`no context token for ${toUserId}`, 'config')
  for (const chunk of chunkText(text, maxSendChars)) {
    await requestJson({
      baseUrl,
      token,
      pathname: 'ilink/bot/sendmessage',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `openclaw-weixin-${randomId()}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
        base_info: { channel_version: channelVersion },
      },
      timeoutMs: 30000,
    })
  }
}

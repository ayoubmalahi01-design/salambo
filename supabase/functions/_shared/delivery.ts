// Small provider-neutral sender used by send-whatsapp and send-sms.
//
// The endpoint and credentials come from function secrets only. A browser can
// never choose the destination API. The provider response body is deliberately
// not relayed: it can contain the recipient number, the message and provider
// diagnostics that should not reach the caller or the logs.

import { HttpError } from './http.ts'

type DeliveryInput = {
  endpoint: string
  apiKey: string
  from: string
  to: string
  body: string
  timeoutMs?: number
}

export async function deliverMessage(input: DeliveryInput): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10000)
  let response: Response

  try {
    response = await fetch(`${input.endpoint.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        body: input.body,
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(504, 'delivery_timeout')
    }
    throw new HttpError(502, 'delivery_failed')
  } finally {
    clearTimeout(timer)
  }

  // Read a bounded body so a broken provider cannot stream indefinitely.
  const text = await response.text().catch(() => '')
  if (text.length > 8192) {
    throw new HttpError(502, 'delivery_failed')
  }

  if (!response.ok) {
    throw new HttpError(502, 'delivery_failed')
  }

  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : ''
      if (parsed.error || status === 'failed' || status === 'error') {
        throw new HttpError(502, 'delivery_failed')
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      // A non-JSON success body is acceptable; providers differ.
    }
  }
}

/** One short line, no control characters, safe to interpolate into a message. */
export function safeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return 'there'
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'there'
}

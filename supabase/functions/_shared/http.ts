// Shared HTTP, CORS, validation and secret-comparison helpers for the
// THE TRAINERS Edge Functions.
//
// Security notes:
//   * no wildcard CORS: only origins listed in ALLOWED_ORIGINS / APP_URL are
//     reflected, with localhost defaults for development;
//   * error bodies contain a stable code only, never a provider message,
//     database detail, recipient address or OTP;
//   * request bodies are size-limited before JSON parsing;
//   * the internal delivery secret is compared without early exit.

export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

export class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export function allowedOrigins(): string[] {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const app = (Deno.env.get('APP_URL') ?? '').trim().replace(/\/+$/, '')
  const list = [...configured, ...(app ? [app] : [])]
  return list.length ? Array.from(new Set(list)) : DEFAULT_ORIGINS
}

export function corsHeaders(req: Request, browser = true): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (!browser) return headers

  const origin = req.headers.get('Origin') ?? ''
  if (origin && allowedOrigins().includes(origin.replace(/\/+$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function json(req: Request, body: unknown, status = 200, browser = true): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req, browser),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export function fail(req: Request, status: number, code: string, browser = true): Response {
  return json(req, { error: code }, status, browser)
}

export function preflight(req: Request, browser = true): Response {
  return new Response('ok', { headers: corsHeaders(req, browser) })
}

export function requirePost(req: Request): void {
  if (req.method !== 'POST') {
    throw new HttpError(405, 'method_not_allowed')
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > 32768) {
    throw new HttpError(413, 'payload_too_large')
  }

  const text = await req.text()
  if (text.length > 32768) {
    throw new HttpError(413, 'payload_too_large')
  }
  if (!text.trim()) {
    throw new HttpError(400, 'invalid_json')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json')
  }
  return parsed as Record<string, unknown>
}

export function bearer(req: Request): string {
  const value = req.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match ? match[1].trim() : ''
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value || !value.trim()) {
    throw new HttpError(500, 'configuration_error', `${name} is not configured`)
  }
  return value.trim()
}

/**
 * Compare two secrets without returning early on the first differing byte.
 * The length difference is folded into the result instead of short-circuiting.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  const max = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let index = 0; index < max; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return diff === 0
}

/** Accepts +<country><number>, 00<country><number> or digits with separators. */
export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') return ''
  let phone = value.trim().replace(/[\s().-]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) return ''
  return phone
}

export function normalizedDigits(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : ''
}

export function isEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const email = value.trim()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
}

export function isUuid(value: unknown): boolean {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function appBaseUrl(): string {
  const configured = (Deno.env.get('APP_URL') ?? '').trim().replace(/\/+$/, '')
  if (configured) return configured
  const first = allowedOrigins()[0] ?? ''
  return first.replace(/\/+$/, '')
}

export function logServerError(scope: string, error: unknown): void {
  if (error instanceof HttpError) {
    if (error.status >= 500) console.error(scope, error.code)
    return
  }
  const message = error instanceof Error ? error.message : 'unknown error'
  // Never log request bodies, recipient addresses or OTP values.
  console.error(scope, message.slice(0, 300))
}

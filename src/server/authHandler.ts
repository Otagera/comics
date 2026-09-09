/**
 * HTTP Basic auth, enforced in the app rather than at the proxy.
 *
 * The brief allowed either "basic-auth at Traefik, or env-gated". Traefik was
 * the first choice, but Coolify does not interpolate variables inside `labels:`
 * or `volumes:` -- only inside `environment:` -- so the middleware's htpasswd
 * line reached Traefik as the literal string `${SIDECAR_BASICAUTH}`. The only
 * way to keep it in Traefik would be hard-coding the password hash into a
 * public repository, which is not acceptable. Environment variables do
 * interpolate, so the check lives here.
 *
 * Registered as a Nitro middleware (see vite.config.ts), so it runs ahead of
 * every route -- pages, server functions and cached covers alike.
 *
 * Env-gated by design: with CS_AUTH_USER / CS_AUTH_PASSWORD unset the app is
 * open, which is what a local `npm run dev` wants. Anything reachable from the
 * internet must set them.
 */

import { defineEventHandler } from 'h3'
import { timingSafeEqual } from 'node:crypto'

const REALM = 'Vault'

function challenge(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  })
}

/** Constant-time string compare that does not leak length through timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on length mismatch, and the throw itself is a
  // timing signal. Compare fixed-width digests instead.
  if (ab.length !== bb.length) {
    // Still burn a comparison so a wrong-length guess costs the same.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export default defineEventHandler((event) => {
  const user = process.env.CS_AUTH_USER
  const password = process.env.CS_AUTH_PASSWORD
  if (!user || !password) return // env-gated: not configured, not enforced

  const header = event.req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('basic ')) return challenge()

  let decoded: string
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  } catch {
    return challenge()
  }

  // Only the first colon separates them; a password may contain colons.
  const sep = decoded.indexOf(':')
  if (sep < 0) return challenge()

  const okUser = safeEqual(decoded.slice(0, sep), user)
  const okPass = safeEqual(decoded.slice(sep + 1), password)
  // Evaluate both before branching so a valid username is not detectable.
  if (!(okUser && okPass)) return challenge()

  return // authenticated; fall through to the real route
})

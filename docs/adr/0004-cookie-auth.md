# ADR 0004: HttpOnly cookie auth with rotating refresh tokens

**Status:** accepted

**Decision.** Short-lived JWT access token and an opaque refresh token, both in `HttpOnly; Secure; SameSite=Strict` cookies. Refresh tokens are stored hashed with a family id and rotated on every use. Reusing a revoked token revokes the whole family. State-changing requests also require a CSRF token.

**Why.** Tokens in localStorage are readable by any injected script. HttpOnly cookies are not. Rotation with reuse detection limits the damage of a stolen refresh token.

**Consequences.** Needs CSRF protection and same-site deployment (or careful CORS). The Vite dev server proxies `/api` so dev matches production behaviour.

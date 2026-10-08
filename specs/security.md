# Security Spec

> **Status:** Implemented — reflects built state as of 2026-10-05  
> **Last updated:** 2026-10-08

---

## Authentication

- **Method:** OAuth 3-legged PKCE (`js/auth.js`)
- **Scopes:** `data:read data:write user-profile:read`
- **Token storage:** `sessionStorage` (cleared on tab close; not `localStorage`)
- **Token refresh:** scheduled automatically ~1 minute before expiry
- **APS Client ID:** safe to commit — PKCE apps have no client secret

## Authorization

Authorization is entirely delegated to Tandem's backend. This app only sees facilities and data
that the authenticated user already has permission to access in Tandem. There are no app-level
roles or additional access controls.

403 responses from the API are handled gracefully (e.g. group metrics returns "No access" UI
instead of showing zeros or crashing).

## Data Sensitivity

This app reads Tandem facility metadata, stream counts, asset counts, model counts, and usage
metrics. It does not read personal data beyond the authenticated user's profile image, or any data
the user couldn't see in Tandem itself. The AI Chat tab additionally reads stream values, tickets,
history and access lists on demand (see below).

## Deeplink / Punch-out Security

### Cross-origin punch-out (Portfolio → Stats)
- Account name and facility URN are passed as **URL hash params** — visible in the address bar
  but not sent to any server (hash is client-side only)
- No token is passed cross-origin; the receiving app authenticates independently via OAuth
- `sessionStorage` is used to carry deeplink params through the OAuth redirect (same-tab only;
  not accessible to other tabs or origins)

### Localhost token sharing (development only)
- On `localhost`, a one-shot cookie (`tandem_shared_token`, `max-age=60s`) carries the access
  token from Portfolio (port 8001) to Stats (port 8000)
- This works because `localhost` cookies are not port-scoped (RFC 6265)
- This cookie is **never set on GitHub Pages** — `SameSite=Lax` prevents cross-origin writes,
  and the receiving origin cannot read it anyway
- The cookie is read once and immediately cleared

## AI Chat

- **LLM API key:** supplied by the user, stored in `localStorage` (`tandem-chat-settings`), never in
  source or logs. It is sent directly from the browser to OpenAI/Anthropic. Anyone with access to the
  browser profile (or an XSS bug) could read it — use a restricted/low-limit key
- **Data sent to the LLM provider:** tool results (facility names, counts, ticket titles, stream
  values, history, access summaries) leave the browser for the chosen provider. User IDs and document
  links are stripped before results go to the model. Users should only enable the tab if that is
  acceptable for their data
- **Read-only tools:** the built-in tools never write to Tandem
- **Output sanitization:** model output is rendered with `marked` then sanitized with `DOMPurify`
  (style/form/input/img forbidden; links forced to `rel=noopener noreferrer`). Chart specs are
  validated and clamped before drawing
- **Tandem MCP (optional):** the MCP access token (`mcp:read mcp:write`, separate from the main Tandem
  session token) is stored in `localStorage` and sent to Anthropic, which calls the Tandem MCP server
  on our behalf. The MCP server also exposes write tools (create/update/delete); the server's tool
  descriptions ask for confirmation of destructive actions, but the app does not enforce it. Disconnect in
  Settings clears the token. Tokens are short-lived; on expiry chat falls back to built-in tools
- **Callback page:** `mcp-callback.html` only displays/relays the OAuth `code`; PKCE verifier is kept
  in `sessionStorage`

## Known Constraints

- Access tokens are never placed in URLs (only in `sessionStorage` and secure cookies)
- All Tandem API calls use HTTPS only
- No hardcoded credentials anywhere in the codebase
- No proprietary implementation details from `dt-server`, `viewer`, or `dt-client` are exposed

## Threat Model (sample app scope)

This is a sample/prototype app. The realistic threats for its audience:

| Threat | Mitigation |
|--------|-----------|
| Token leakage via URL | Tokens never in URLs; only in `sessionStorage` |
| XSS | No `innerHTML` with unsanitized user input; all dynamic content uses `escapeHtml()` |
| CSRF | PKCE state parameter; no server-side session |
| Phishing via deeplink | Hash params carry only account name + URN (not tokens); harmless if intercepted |
| Unauthorized data access | Tandem API enforces authorization; 403s handled gracefully |
| Prompt injection via facility data (ticket/asset names) | Built-in tools are read-only; output sanitized; MCP write tools are the residual risk — authorize MCP only when needed |
| LLM key theft | Key only in `localStorage`; sanitized rendering limits XSS; recommend a restricted key |

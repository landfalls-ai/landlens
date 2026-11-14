// The renderer's Content Security Policy, shared by main (as a header) and the build (as a <meta> tag, because a
// page loaded from file:// gets no response headers to carry it).

/** The production CSP: only our own files; no eval, no inline scripts, no network. */
export const CSP_PROD =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** The same policy for a <meta> tag, which may not carry frame-ancestors. */
export const CSP_META = CSP_PROD.replace(" frame-ancestors 'none';", "");

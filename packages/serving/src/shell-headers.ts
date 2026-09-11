/** Policy shared by the hosted shell and local patch runtime; no server dependencies. */
export const PATCH_ROBOTS_TAG = "noindex";
export const NO_REFERRER_POLICY = "no-referrer";
export const PATCH_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";
export const NO_STORE_CACHE_CONTROL = "no-store";
export const PUBLIC_PATCH_CACHE_CONTROL = "public, max-age=60";
export const PRIVATE_PATCH_CACHE_CONTROL = "private, no-store";

const STATIC_DOCUMENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "frame-src 'self' about:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

export const PATCH_CONTENT_SECURITY_POLICY = `${STATIC_DOCUMENT_SECURITY_POLICY}; frame-ancestors 'none'`;

/** Both the HTTP policy and iframe sandbox must grant a capability. */
export const STATIC_CONTENT_SECURITY_POLICY = `sandbox; ${STATIC_DOCUMENT_SECURITY_POLICY}`;
export const SCRIPTED_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
  "connect-src 'none'"
].join("; ");

/** frame-src is egress containment even for script-initiated child navigation. */
export const SCRIPTED_SHELL_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

export function contentSecurityPolicy(tier: number): string {
  return tier >= 1 ? SCRIPTED_CONTENT_SECURITY_POLICY : STATIC_CONTENT_SECURITY_POLICY;
}

export function shellContentSecurityPolicy(tier: number, frontendApiHost?: string): string {
  const policy = tier >= 1 ? SCRIPTED_SHELL_SECURITY_POLICY : PATCH_CONTENT_SECURITY_POLICY;
  if (frontendApiHost === undefined) return policy;
  const sources = `https://${frontendApiHost}`;
  return tier >= 1
    ? policy
        .replace("script-src 'self'", `script-src 'self' ${sources}`)
        .replace("connect-src 'self'", `connect-src 'self' ${sources}`)
    : `${policy}; script-src 'self' ${sources}; connect-src ${sources}`;
}

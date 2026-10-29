/** Policy shared by the hosted shell and local patch runtime; no server dependencies. */
export const PATCH_ROBOTS_TAG = "noindex";
export const NO_REFERRER_POLICY = "no-referrer";
export const PATCH_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";
export const NO_STORE_CACHE_CONTROL = "no-store";
export const PUBLIC_PATCH_CACHE_CONTROL = "public, max-age=60";
export const PRIVATE_PATCH_CACHE_CONTROL = "private, no-store";

/**
 * Patchy's own notices in place of a patch: no script, no frames, no forms, fonts only from their
 * own bytes.
 */
export const PATCH_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

/** A patch's document in its frame. Both the HTTP policy and iframe sandbox must grant a capability. */
export const CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
  "connect-src 'none'",
  "frame-ancestors 'self'"
].join("; ");

/** The shell around the frame. frame-src is egress containment even for script-initiated child navigation. */
export const SHELL_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  // The tab's icon is an inline data: URL.
  "img-src data:",
  "frame-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

/** Clerk keeps the session cookie fresh from a blob worker wherever the shell loads it. */
export function shellContentSecurityPolicy(frontendApiHost?: string): string {
  if (frontendApiHost === undefined) return SHELL_SECURITY_POLICY;
  const sources = `https://${frontendApiHost}`;
  return `${SHELL_SECURITY_POLICY.replace(
    "script-src 'self'",
    `script-src 'self' ${sources}`
  ).replace("connect-src 'self'", `connect-src 'self' ${sources}`)}; worker-src blob:`;
}

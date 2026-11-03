/**
 * The secret check: a short list of credential shapes, matched by prefix and form, never by
 * entropy, which would flag Patchy's own ids and commit SHAs. Emails pass. A hit refuses the
 * whole submission; the refusal names each field and the kind of credential, never the value.
 */

/** A credential shape: its stable kind, the words a refusal names it with, and its form. */
interface Pattern {
  readonly kind: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * A field reports each kind once. Stripe and Clerk secret keys share their `sk_live_` and
 * `sk_test_` form, so they are one kind; PostHog's `phc_` project key is public and passes.
 */
const patterns: ReadonlyArray<Pattern> = [
  { kind: "patchy_token", label: "a Patchy machine token", pattern: /\bpp_[A-Za-z0-9_-]{32,}/ },
  {
    kind: "patchy_agent_token",
    label: "a Patchy agent connection token",
    pattern: /\bpw[arc]_[A-Za-z0-9_-]{32,}/
  },
  {
    kind: "aws_access_key",
    label: "an AWS access key id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/
  },
  {
    kind: "github_token",
    label: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/
  },
  { kind: "slack_token", label: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    kind: "stripe_or_clerk_secret_key",
    label: "a Stripe or Clerk secret key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/
  },
  {
    kind: "anthropic_key",
    label: "an Anthropic API key",
    pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/
  },
  {
    kind: "openai_key",
    label: "an OpenAI API key",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/
  },
  { kind: "google_api_key", label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  {
    kind: "posthog_secret_key",
    label: "a PostHog personal or secret key",
    pattern: /\bph[xs]_[A-Za-z0-9]{20,}/
  },
  { kind: "neon_api_key", label: "a Neon API key", pattern: /\bnapi_[A-Za-z0-9]{32,}/ },
  {
    kind: "private_key",
    label: "a private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]{0,200}?[A-Za-z0-9+/]{32}/
  },
  {
    kind: "jwt",
    label: "a JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
  },
  {
    // A placeholder in angle brackets, or a run of `*`, is not a password.
    kind: "url_password",
    label: "a password in a URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!<[^\s@]*>@|\*+@)[^\s/@]+@/i
  }
];

/** One credential the check found: which field held it and what kind it looked like. */
export interface Found {
  readonly field: string;
  readonly kind: string;
  readonly label: string;
}

/** Every credential shape in each field, in field order, each kind once per field. */
export const scan = (fields: Readonly<Record<string, string | null>>): ReadonlyArray<Found> =>
  Object.entries(fields).flatMap(([field, text]) =>
    text === null
      ? []
      : patterns
          .filter(({ pattern }) => pattern.test(text))
          .map(({ kind, label }) => ({ field, kind, label }))
  );

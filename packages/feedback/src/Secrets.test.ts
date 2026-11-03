import { describe, expect, it } from "vitest";
import * as Secrets from "./Secrets.js";

/**
 * Credential-shaped values are joined at runtime from pieces, so the repository holds no string
 * a secret scanner would take for a real credential.
 */
const shaped = (...parts: ReadonlyArray<string>) => parts.join("");
const base64url = "Ab3_dE6-gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9nP";

/** Each kind with a value it catches and a near miss it lets through. */
const cases: ReadonlyArray<readonly [kind: string, caught: string, passes: string]> = [
  ["patchy_token", shaped("p", "p_", base64url), shaped("p", "p_", "short")],
  ["patchy_agent_token", shaped("pw", "a_", base64url), shaped("pw", "x_", base64url)],
  ["aws_access_key", shaped("AK", "IA", "Q3EGRGQ7XKW2NL5T"), shaped("AK", "IA", "Q3EGRGQ7")],
  ["github_token", shaped("gh", "p_", "a1B2".repeat(9)), shaped("gh", "p_", "a1B2c3")],
  [
    "github_token",
    shaped("github", "_pat_", "11ABCDE", "x9".repeat(30)),
    "github_pat_ in a sentence"
  ],
  [
    "slack_token",
    shaped("xo", "xb-", "123456789012-abcdefghijkl"),
    shaped("xo", "xz-", "123456789012-abcdefghijkl")
  ],
  [
    "slack_token",
    shaped("xa", "pp-1-", "A0123456789-1234567890123-", "a1b2c3d4".repeat(4)),
    "xapp-config-loader in the build"
  ],
  [
    "slack_token",
    shaped("xoxe", ".xapp-1-", "A0123456789-1234567890123-", "a1b2c3d4".repeat(4)),
    "xoxe.xapp- tokens rotate"
  ],
  [
    "stripe_or_clerk_secret_key",
    shaped("sk", "_live_", "a1B2".repeat(6)),
    shaped("pk", "_live_", "a1B2".repeat(6))
  ],
  ["anthropic_key", shaped("sk-", "ant-api03-", "a1B2_c3D4-".repeat(4)), "sk-ant- keys"],
  ["openai_key", shaped("sk-", "proj-", "a1B2_c3D4-".repeat(4)), "scikit, or sk-learn"],
  [
    "google_api_key",
    shaped("AI", "za", "Sy", "a1B2c3D4e5".repeat(4).slice(0, 33)),
    shaped("AI", "za", "Sya1B2")
  ],
  [
    "posthog_secret_key",
    shaped("ph", "x_", "a1B2c3D4e5".repeat(4)),
    shaped("ph", "c_", "a1B2c3D4e5".repeat(4))
  ],
  ["neon_api_key", shaped("na", "pi_", "a1b2c3d4".repeat(8)), shaped("na", "pi_", "a1b2c3")],
  [
    "private_key",
    shaped("-----BEGIN RSA ", "PRIVATE KEY-----\n", "MIIEowIBAAKCAQEA".repeat(4)),
    shaped("-----BEGIN ", "PUBLIC KEY-----\n", "MIIEowIBAAKCAQEA".repeat(4))
  ],
  [
    "jwt",
    shaped("eyJ", "hbGciOiJIUzI1NiJ9.", "eyJ", "zdWIiOiIxMjM0NSJ9.", "SflKxwRJSMeKKF2QT4"),
    shaped("eyJ", "hbGciOiJIUzI1NiJ9")
  ],
  [
    "url_password",
    shaped("postgres://app:", "hunter2", "@db.example.com/app"),
    "postgres://app:<token>@db.example.com/app"
  ],
  ["url_password", shaped("postgres://", ":hunter2", "@db/app"), "postgres://:<token>@db/app"],
  [
    "url_password",
    shaped("postgresql://db/app?user=app&", "password=", "hunter2"),
    "postgresql://db/app?user=app&password=****&sslmode=require"
  ]
];

describe("the secret check", () => {
  it.each(cases)("catches %s and lets its near miss through", (kind, caught, passes) => {
    expect(
      Secrets.scan({ text: `Seen in my config: ${caught}` }).map((found) => found.kind)
    ).toEqual([kind]);
    expect(Secrets.scan({ text: `Seen in my config: ${passes}` })).toEqual([]);
  });

  it("names each field that holds one, never the value", () => {
    const token = shaped("gh", "p_", "a1B2".repeat(9));
    const found = Secrets.scan({ text: `Sync fails with ${token}`, why: null, link: token });
    expect(found).toEqual([
      { field: "text", kind: "github_token", label: "a GitHub token" },
      { field: "link", kind: "github_token", label: "a GitHub token" }
    ]);
    expect(JSON.stringify(found)).not.toContain(token);
  });

  it("passes emails, Patchy's own ids, commit SHAs, placeholders and plain addresses", () => {
    for (const text of [
      "Mail ada@example.com when it ships",
      "req_a1b2c3d4e5f6g7h8i9j0k1l2 and patch abcdefghij12",
      "Broken since 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f",
      "postgres://app:****@db.example.com/app",
      "https://db.example.com:5432/app",
      "A Patchy token looks like pp_<token>"
    ])
      expect(Secrets.scan({ text })).toEqual([]);
  });
});

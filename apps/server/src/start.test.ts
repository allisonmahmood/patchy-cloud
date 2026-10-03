import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { clerkEnv } from "@patchy/auth/testing";

const subprocessTimeout = 60_000;
const validEnv = (): NodeJS.ProcessEnv => ({
  ...clerkEnv(),
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy",
  PATCHY_COMPANY_DB_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
  PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
  PATCHY_COMPANY_DB_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy"
});

/** Starts the real entrypoint against an unreachable Postgres and returns its refusal output. */
const refusedStart = (env: NodeJS.ProcessEnv) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      fileURLToPath(new URL("./start.ts", import.meta.url))
    ],
    { env, encoding: "utf8", timeout: subprocessTimeout }
  );
  if (result.status === null) {
    expect.fail(
      `Server subprocess exited without a status: signal=${result.signal}, timeout=${subprocessTimeout}ms`
    );
  }
  expect(result.status).toBe(1);
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain("server listening");
  return output;
};

// One key per config group start.ts checks before Postgres; the company-database
// group is covered by the invalid-URL case below.
for (const missing of ["DATABASE_URL", "PATCHY_CREDENTIAL_KEYS", "CLERK_SECRET_KEY"]) {
  it(`names missing ${missing} before trying to connect to Postgres`, () => {
    const env = validEnv();
    delete env[missing];
    expect(refusedStart(env)).toContain(missing);
  }, 75_000);
}

it("rejects an invalid company database URL without exposing its credential", () => {
  const secret = "private-company-db-password";
  const output = refusedStart({
    ...validEnv(),
    PATCHY_COMPANY_DB_ADMIN_URL: `https://operator:${secret}@localhost/patchy`
  });
  expect(output).toContain("PATCHY_COMPANY_DB_ADMIN_URL");
  expect(output).not.toContain(secret);
}, 75_000);

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { clerkEnv } from "@patchy/auth/testing";

const subprocessTimeout = 60_000;

for (const missing of [
  "DATABASE_URL",
  "PATCHY_COMPANY_DB_ADMIN_URL",
  "PATCHY_COMPANY_DB_URL",
  "PATCHY_CREDENTIAL_KEYS",
  "PATCHY_PUBLIC_BASE_URL",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY"
]) {
  it(`names missing ${missing} before trying to connect to Postgres`, () => {
    const env: NodeJS.ProcessEnv = {
      ...clerkEnv(),
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy",
      PATCHY_COMPANY_DB_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
      PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
      PATCHY_COMPANY_DB_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy"
    };
    delete env[missing];
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
    expect(`${result.stdout}${result.stderr}`).toContain(missing);
    expect(`${result.stdout}${result.stderr}`).not.toContain("server listening");
  }, 75_000);
}

for (const key of ["PATCHY_COMPANY_DB_ADMIN_URL", "PATCHY_COMPANY_DB_URL"]) {
  it(`rejects invalid ${key} without exposing its credential`, () => {
    const secret = "private-company-db-password";
    const env = {
      ...clerkEnv(),
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy",
      PATCHY_COMPANY_DB_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
      PATCHY_COMPANY_DB_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy",
      PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
      [key]: `https://operator:${secret}@localhost/patchy`
    };
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
    expect(output).toContain(key);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("server listening");
  }, 75_000);
}

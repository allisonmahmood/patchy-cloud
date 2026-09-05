import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { clerkEnv } from "@patchy/auth/testing";

for (const missing of [
  "DATABASE_URL",
  "PATCHY_PUBLIC_BASE_URL",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY"
]) {
  it(`names missing ${missing} before trying to connect to Postgres`, () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...clerkEnv(),
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/patchy"
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
      { env, encoding: "utf8", timeout: 10_000 }
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(missing);
    expect(`${result.stdout}${result.stderr}`).not.toContain("server listening");
  });
}

import * as Schema from "effect/Schema";
import { test, expect, openSeededPatch } from "./fixtures.js";

const decodeHandoff = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(true),
      status: Schema.Literal("awaiting_confirmation"),
      verificationUrl: Schema.String,
      userCode: Schema.String
    })
  )
);
const decodeLogin = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(true),
      status: Schema.Literal("logged_in"),
      company: Schema.Struct({ name: Schema.String }),
      user: Schema.Struct({ email: Schema.String }),
      machine: Schema.Struct({ id: Schema.String, name: Schema.String })
    })
  )
);
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      company: Schema.Struct({ name: Schema.String }),
      user: Schema.Struct({ email: Schema.String }),
      machine: Schema.Struct({ id: Schema.String, name: Schema.String })
    })
  )
);
const decodeFailure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(false),
      kind: Schema.Literal("rejected"),
      error: Schema.String
    })
  )
);

test("patchy-login: browser confirmation logs the packed CLI in; browser revoke removes access", async ({
  live
}) => {
  const page = await openSeededPatch(live);
  const start = await live.cli(["login", "--json"]);
  expect(start.status).toBe(0);
  const handoff = decodeHandoff(start.stdout);
  expect(new URL(handoff.verificationUrl).origin).toBe(live.origin);
  expect((await page.goto(handoff.verificationUrl))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: handoff.userCode, exact: true })).toBeVisible();
  await expect(page.getByText(live.settings.browserEmail, { exact: true })).toBeVisible();
  await expect(page.getByText("Patchy Dev", { exact: true })).toBeVisible();
  const machineName = "Browser-confirmed machine";
  await page.getByLabel("Machine name", { exact: true }).fill(machineName);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirmed.", exact: true })).toBeVisible();
  const complete = await live.cli(["login", "--complete", handoff.userCode, "--json"]);
  expect(complete.status).toBe(0);
  const loggedIn = decodeLogin(complete.stdout);
  expect(loggedIn.company.name).toBe("Patchy Dev");
  expect(loggedIn.user.email).toBe(live.settings.browserEmail);
  expect(loggedIn.machine.name).toBe(machineName);
  const whoami = await live.cli(["whoami", "--json"]);
  expect(whoami.status).toBe(0);
  expect(decodeIdentity(whoami.stdout)).toEqual({
    company: { name: "Patchy Dev" },
    user: { email: live.settings.browserEmail },
    machine: loggedIn.machine
  });
  expect((await page.goto(`${live.origin}/machines`))?.status()).toBe(200);
  await page.getByRole("button", { name: `Revoke ${machineName}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: machineName, exact: true })).toHaveCount(0);
  const revoked = await live.cli(["whoami", "--json"]);
  expect(revoked.status).toBe(2);
  expect(revoked.stdout).toBe("");
  expect(decodeFailure(revoked.stderr).kind).toBe("rejected");
});

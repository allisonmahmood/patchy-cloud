import { setTimeout as delay } from "node:timers/promises";
import * as Schema from "effect/Schema";
import { test, expect, openSeededPatch, signIn } from "./fixtures.js";

const decodeExpiry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Number }))
);

test("login-door: portal handshake, session renewal and company isolation", async ({ live }) => {
  const page = await openSeededPatch(live);
  // URL-filtered cookie inspection excludes Secure cookies on HTTP loopback too.
  const cookies = await page.context().cookies();
  const session = cookies.find(
    (cookie) =>
      cookie.domain === new URL(live.origin).hostname &&
      /^__session(?:_|$)/.test(cookie.name) &&
      cookie.value
  );
  expect(session, "the portal handshake established a browser session").toBeDefined();
  const claims = decodeExpiry(Buffer.from(session!.value.split(".")[1]!, "base64url").toString());
  const wait = claims.exp * 1000 + 6_000 - Date.now();
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThan(90_000);
  // Wait past this token's actual expiry plus Clerk's clock skew, with the shell running.
  await delay(wait);
  const navigations: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigations.push(request.url());
  });
  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  expect(refreshed?.headers()["cache-control"]).toBe("private, no-store");
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Company-only browser fixture" })
  ).toBeVisible();
  expect(navigations.some((url) => new URL(url).pathname.startsWith("/sign-in"))).toBe(false);
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);

  await live.createOutsider();
  const outsider = await (await live.newContext()).newPage();
  expect((await outsider.goto(live.patchUrl))?.status()).toBe(401);
  await signIn(
    outsider,
    live.settings.outsiderEmail,
    (url) => url.origin === live.origin && url.pathname === "/join"
  );
  await expect(outsider.getByText(live.settings.outsiderEmail, { exact: true })).toBeVisible();
  await outsider.getByLabel("Company name", { exact: true }).fill("Browser outsider company");
  await outsider.getByLabel("Company handle", { exact: true }).fill("browser-outsider");
  await outsider.getByRole("button", { name: "Create company", exact: true }).click();
  await outsider.waitForURL(live.patchUrl);
  const refused = await outsider.reload();
  expect(refused?.status()).toBe(404);
  const refusedBody = await refused!.text();
  const missing = await outsider.goto(`${live.origin}/d/000000000000`);
  expect(missing?.status()).toBe(404);
  expect(missing?.headers()["cache-control"]).toBe("private, no-store");
  expect(refused?.headers()["cache-control"]).toBe(missing?.headers()["cache-control"]);
  expect(await missing!.text()).toBe(refusedBody);
  // Observe successful enrollment through its public page, not a database side channel.
  expect((await outsider.goto(`${live.origin}/company`))?.status()).toBe(200);
  await expect(
    outsider.getByRole("heading", { name: "Browser outsider company", exact: true })
  ).toBeVisible();
});

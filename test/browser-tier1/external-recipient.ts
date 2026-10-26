import type { BrowserContext } from "@playwright/test";
import { signedInCookies, signSession } from "../../packages/auth/src/testing.js";
import type { Instance } from "./instance.js";

export const recipient = { sub: "user_external_browser", email: "recipient@example.com" };
export async function recipientSession(
  context: BrowserContext,
  instance: Instance,
  expired = false,
  identity = recipient
) {
  const now = Math.floor(Date.now() / 1000);
  const token = signSession({
    ...identity,
    azp: instance.origin,
    iat: now - 300,
    nbf: now - 300,
    exp: expired ? now - 120 : now + 3600
  });
  await context.clearCookies();
  await context.addCookies(
    signedInCookies(token)
      .split("; ")
      .map((cookie) => {
        const at = cookie.indexOf("=");
        return {
          name: cookie.slice(0, at),
          value: cookie.slice(at + 1),
          url: instance.origin,
          sameSite: "Lax" as const
        };
      })
  );
  return token;
}

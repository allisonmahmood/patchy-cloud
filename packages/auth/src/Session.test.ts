// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- RSA fixtures and Clerk token expiry use Node's real clock.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { assert, it } from "@effect/vitest";
import { afterAll } from "vitest";
import { constants } from "@clerk/backend/internal";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Session from "./Session.js";
import {
  clerkEnv,
  externalRequests,
  FRONTEND_API_HOST,
  publicKey,
  publishableKey,
  PUBLIC_BASE_URL,
  signedInCookies,
  signHandshake,
  signSession
} from "./testing.js";

const configured = (env: Record<string, string> = clerkEnv()) =>
  Session.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
const request = (cookie?: string, url = `${PUBLIC_BASE_URL}/join`, headers: HeadersInit = {}) => {
  const merged = new Headers(headers);
  if (cookie !== undefined) merged.set("cookie", cookie);
  return new Request(url, { headers: merged });
};
const signedIn = (result: Session.SessionResult) => {
  assert.strictEqual(result.status, "signed-in");
  if (result.status !== "signed-in") throw new Error("Expected a signed-in session");
  return result;
};
const handshake = (result: Session.SessionResult) => {
  assert.strictEqual(result.status, "handshake");
  if (result.status !== "handshake") throw new Error("Expected a handshake response");
  assert.strictEqual(result.response.status, 307);
  for (const name of result.response.headers.keys())
    assert.include(["location", "set-cookie"], name);
  return result.response;
};

// No suite is allowed to silently replace production verification with remote JWKS.
afterAll(() => assert.deepStrictEqual(externalRequests, []));

it.layer(configured())("Session", (it) => {
  it.effect("verifies cookie claims locally and refuses bearer-only page authentication", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const token = signSession();
      assert.deepStrictEqual(
        signedIn(yield* session.authenticate(request(signedInCookies(token)))).claims,
        {
          sub: "user_dev",
          email: "dev@patchy.local",
          name: "Patchy Dev",
          sid: "sess_offline"
        }
      );
      const signedOut = yield* session.authenticate(request("__clerk_db_jwt=offline-browser"));
      assert.deepStrictEqual(signedOut, {
        status: "signed-out",
        reason: "session-token-and-uat-missing",
        handshakeFailed: false,
        cookies: []
      });
      assert.strictEqual(
        (yield* session.authenticate(
          request(undefined, undefined, { authorization: `Bearer ${token}` })
        )).status,
        "signed-out"
      );
    })
  );

  it.effect("refuses forged, expired and incomplete claims without remote verification", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const token = signSession();
      const parts = token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<
        string,
        unknown
      >;
      parts[1] = Buffer.from(JSON.stringify({ ...payload, sub: "user_attacker" })).toString(
        "base64url"
      );
      assert.strictEqual(
        (yield* session.authenticate(request(signedInCookies(parts.join("."))))).status,
        "signed-out"
      );
      const now = Math.floor(Date.now() / 1_000);
      const expired = signSession({ iat: now - 120, nbf: now - 120, exp: now - 60 });
      assert.strictEqual(
        (yield* session.authenticate(request(signedInCookies(expired)))).status,
        "signed-out"
      );
      const incomplete = yield* session.authenticate(
        request(signedInCookies(signSession({ email: "" })))
      );
      assert.deepStrictEqual(incomplete, {
        status: "signed-out",
        reason: "session-claims-invalid",
        handshakeFailed: false,
        cookies: []
      });
    })
  );

  it.effect("pins the handshake return origin and drives development hops by hand", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const now = Math.floor(Date.now() / 1_000);
      const expired = signSession({ iat: now - 120, nbf: now - 120, exp: now - 60 });
      const first = handshake(
        yield* session.authenticate(
          request(signedInCookies(expired), "http://internal:9000/join?return=%2Fcompany", {
            accept: "text/html",
            "sec-fetch-dest": "document",
            host: "evil.invalid",
            "x-forwarded-host": "evil.invalid, proxy.invalid",
            "x-forwarded-proto": "https",
            "x-forwarded-port": "444",
            "x-forwarded-for": "203.0.113.9",
            "cloudfront-forwarded-proto": "https",
            forwarded: "host=evil.invalid;proto=https"
          })
        )
      );
      const upstream = new URL(first.headers.get("location")!);
      assert.strictEqual(upstream.origin, `https://${FRONTEND_API_HOST}`);
      assert.strictEqual(upstream.pathname, "/v1/client/handshake");
      assert.strictEqual(
        upstream.searchParams.get("redirect_url"),
        `${PUBLIC_BASE_URL}/join?return=%2Fcompany`
      );
      assert.strictEqual(upstream.searchParams.get("format"), "nonce");
      // FAPI's token return format is signed by the same key, so this leg is offline.
      const jwt = signSession();
      const directives = [
        `__session=${jwt}; Path=/; SameSite=Lax`,
        `__client_uat=${now}; Domain=127.0.0.1; Path=/; SameSite=Lax`,
        "__clerk_db_jwt=offline-browser; Path=/; SameSite=Lax"
      ];
      const returning = new URL(upstream.searchParams.get("redirect_url")!);
      returning.searchParams.set(constants.QueryParameters.Handshake, signHandshake(directives));
      const second = handshake(
        yield* session.authenticate(request(undefined, returning.href, { accept: "text/html" }))
      );
      assert.strictEqual(
        second.headers.get("location"),
        `${PUBLIC_BASE_URL}/join?return=%2Fcompany`
      );
      assert.deepStrictEqual(second.headers.getSetCookie(), directives);
      const cookie = second.headers
        .getSetCookie()
        .map((directive) => directive.split(";")[0]!)
        .join("; ");
      const final = yield* session.authenticate(request(cookie, second.headers.get("location")!));
      assert.strictEqual(signedIn(final).claims.sid, "sess_offline");
    })
  );

  it.effect(
    "stops signed-out handshake returns instead of following Clerk's cleanup Location",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Session;
        const url = new URL(`${PUBLIC_BASE_URL}/join`);
        url.searchParams.set(
          constants.QueryParameters.Handshake,
          signHandshake(["__session=; Max-Age=0; Path=/"])
        );
        const result = yield* session.authenticate(
          request(undefined, url.href, { accept: "text/html" })
        );
        assert.deepStrictEqual(result, {
          status: "signed-out",
          reason: "session-token-missing",
          handshakeFailed: true,
          cookies: ["__session=; Max-Age=0; Path=/"]
        });
        const cookieReturn = yield* session.authenticate(
          request(`${constants.Cookies.Handshake}=${signHandshake([])}`, undefined, {
            accept: "text/html"
          })
        );
        assert.strictEqual(cookieReturn.status, "signed-out");
        if (cookieReturn.status === "signed-out") assert.isTrue(cookieReturn.handshakeFailed);
      })
  );

  it.effect("does not restart an invalid handshake or expose its token as a reason", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const url = new URL(`${PUBLIC_BASE_URL}/join`);
      url.searchParams.set(constants.QueryParameters.Handshake, "not-a-jwt-secret");
      const result = yield* session.authenticate(
        request(undefined, url.href, { accept: "text/html" })
      );
      assert.deepStrictEqual(result, {
        status: "signed-out",
        reason: "handshake-verification-failed",
        handshakeFailed: true,
        cookies: []
      });
    })
  );

  it.effect("reports SDK revocation failures without pretending sign-out succeeded", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      // requireId fails inside the real Backend SDK before any fetch is attempted.
      const error = yield* session.revoke("").pipe(Effect.flip);
      assert.instanceOf(error, Session.SessionError);
      assert.strictEqual(error.operation, "revoke");
      assert.instanceOf(error.cause, Error);
    })
  );
});

for (const instance of ["test", "live"] as const) {
  for (const shape of ["spki", "pkcs1"] as const) {
    it.effect(`accepts ${shape} RSA PEM and pk_${instance} keys`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Session;
        assert.strictEqual(
          signedIn(yield* session.authenticate(request(signedInCookies()))).claims.sub,
          "user_dev"
        );
        assert.strictEqual(session.frontendApiHost, FRONTEND_API_HOST);
      }).pipe(
        Effect.provide(
          configured({
            ...clerkEnv(),
            CLERK_PUBLISHABLE_KEY: publishableKey(instance),
            CLERK_SECRET_KEY: `sk_${instance}_offline`,
            CLERK_JWT_KEY: publicKey.export({ type: shape, format: "pem" }).toString()
          })
        )
      )
    );
  }
}

it.effect(
  "accepts padded publishable keys and locally verifies the production handshake without a cleanup hop",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const jwt = signSession();
      const cookie = `${constants.Cookies.Handshake}=${signHandshake([`__session=${jwt}; Path=/`])}`;
      const result = signedIn(yield* session.authenticate(request(cookie)));
      assert.strictEqual(result.claims.sid, "sess_offline");
      assert.deepStrictEqual(result.cookies, [`__session=${jwt}; Path=/`]);
    }).pipe(
      Effect.provide(
        configured({
          ...clerkEnv(),
          CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64")}`,
          CLERK_SECRET_KEY: "sk_live_offline"
        })
      )
    )
);

it.effect("enforces the configured authorized origin but accepts absent azp", () =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    assert.strictEqual(
      (yield* session.authenticate(
        request(signedInCookies(signSession({ azp: "https://foreign.invalid" })))
      )).status,
      "signed-out"
    );
    assert.strictEqual(
      signedIn(
        yield* session.authenticate(request(signedInCookies(signSession({ azp: PUBLIC_BASE_URL }))))
      ).claims.sub,
      "user_dev"
    );
    assert.strictEqual(
      signedIn(yield* session.authenticate(request(signedInCookies(signSession({ azp: null })))))
        .claims.sub,
      "user_dev"
    );
    const returned = yield* session.authenticate(
      request(
        `${constants.Cookies.Handshake}=${signHandshake([
          `__session=${signSession({ azp: "https://foreign.invalid" })}; Path=/`
        ])}`,
        undefined,
        { accept: "text/html" }
      )
    );
    assert.strictEqual(returned.status, "signed-out");
    if (returned.status === "signed-out") {
      assert.isTrue(returned.handshakeFailed);
      assert.strictEqual(returned.reason, "token-invalid-authorized-parties");
    }
  }).pipe(Effect.provide(configured({ ...clerkEnv(), CLERK_AUTHORIZED_PARTIES: PUBLIC_BASE_URL })))
);

it.effect(
  "expires every SDK cookie family at the setter's scopes, including parent-domain handshakes",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      const cleared = session.signOutCookies();
      // Model browser identity: equal names at different Domain/Path do not replace each other.
      const identity = (directive: string) => {
        const [pair, ...attributes] = directive.split(";").map((part) => part.trim());
        const domain = attributes.find((part) => part.startsWith("Domain=")) ?? "host-only";
        const path = attributes.find((part) => part.startsWith("Path=")) ?? "Path=/";
        return `${pair!.split("=")[0]}|${domain}|${path}`;
      };
      const jar = new Map<string, string>();
      const suffix = cleared
        .find((cookie) => cookie.startsWith(`${constants.Cookies.Session}_`))!
        .split("=")[0]!
        .slice(`${constants.Cookies.Session}_`.length);
      for (const base of Object.values(constants.Cookies)) {
        for (const name of [base, `${base}_${suffix}`]) {
          const cookie = `${name}=present; Path=/`;
          jar.set(identity(cookie), cookie);
          if (
            base === constants.Cookies.ClientUat ||
            base === constants.Cookies.Handshake ||
            base === constants.Cookies.HandshakeNonce
          ) {
            const scoped = `${name}=present; Domain=example.co.uk; Path=/`;
            jar.set(identity(scoped), scoped);
          }
        }
      }
      for (const directive of cleared) {
        assert.include(directive, "Max-Age=0");
        jar.delete(identity(directive));
      }
      assert.deepStrictEqual([...jar.values()], []);
    }).pipe(
      Effect.provide(
        configured({ ...clerkEnv(), PATCHY_PUBLIC_BASE_URL: "https://app.example.co.uk" })
      )
    )
);

for (const missing of ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "PATCHY_PUBLIC_BASE_URL"]) {
  it.effect(`refuses to construct without ${missing}`, () =>
    Effect.gen(function* () {
      const env = clerkEnv();
      delete env[missing];
      const error = yield* Session.Session.pipe(Effect.provide(configured(env)), Effect.flip);
      assert.include(error.message, missing);
    })
  );
}

const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
for (const [setting, value] of [
  ["CLERK_PUBLISHABLE_KEY", "pk_test_not-base64"],
  ["CLERK_PUBLISHABLE_KEY", `pk_test_${Buffer.from("evil.invalid/path$").toString("base64")}`],
  ["CLERK_SECRET_KEY", "sk_live_wrongenvironment"],
  ["CLERK_SECRET_KEY", ""],
  ["CLERK_JWT_KEY", "not a PEM"],
  ["CLERK_JWT_KEY", ecKey],
  ["PATCHY_PUBLIC_BASE_URL", "https://user:password@patchy.invalid"],
  ["PATCHY_PUBLIC_BASE_URL", "https://patchy.invalid/path"],
  ["CLERK_AUTHORIZED_PARTIES", `${PUBLIC_BASE_URL},https://other.invalid`],
  ["CLERK_AUTHORIZED_PARTIES", "https://patchy.invalid/path"]
]) {
  it.effect(`rejects invalid ${setting} at boot (${value === ecKey ? "EC key" : value})`, () =>
    Effect.gen(function* () {
      const error = yield* Session.Session.pipe(
        Effect.provide(configured({ ...clerkEnv(), [setting!]: value! })),
        Effect.flip
      );
      assert.include(error.message, setting!);
    })
  );
}

it.effect("allows omitted local JWT key without fetching during boot", () =>
  Effect.gen(function* () {
    const env = clerkEnv();
    delete env["CLERK_JWT_KEY"];
    const session = yield* Session.Session.pipe(Effect.provide(configured(env)));
    assert.strictEqual(
      (yield* session.authenticate(request("__clerk_db_jwt=offline-browser"))).status,
      "signed-out"
    );
  })
);

it.effect("guards redirected fetches without changing manual hops or loopback request bodies", () =>
  Effect.tryPromise({
    try: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // Isolate intentional denials: every production Session test still records zero.
      const script = `
        import assert from "node:assert/strict";
        import { createServer } from "node:http";
        import { once } from "node:events";
        import { externalRequests } from ${JSON.stringify(new URL("./testing.ts", import.meta.url).href)};
        const server = createServer(async (req, res) => {
          if (req.url === "/outside") {
            res.writeHead(302, { location: "https://offline-redirect.invalid/private?secret=omitted" }).end();
          } else if (req.url === "/preserve" || req.url === "/convert") {
            res.writeHead(req.url === "/preserve" ? 307 : 303, { location: "/echo" }).end();
          } else {
            let body = "";
            for await (const chunk of req) body += chunk;
            res.end(req.method + ":" + body);
          }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = "http://127.0.0.1:" + server.address().port;
        try {
          const manual = await fetch(base + "/outside", { redirect: "manual" });
          assert.equal(manual.status, 302);
          await manual.body?.cancel();
          await assert.rejects(fetch(base + "/outside", { redirect: "error" }));
          assert.deepEqual(externalRequests, []);
          assert.equal(await (await fetch(base + "/preserve", { method: "POST", body: "payload" })).text(), "POST:payload");
          assert.equal(await (await fetch(base + "/convert", { method: "POST", body: "payload" })).text(), "GET:");
          await assert.rejects(fetch(base + "/outside"), /Offline Clerk fixture refused/);
          assert.deepEqual(externalRequests, ["GET https://offline-redirect.invalid/private"]);
        } finally {
          server.closeAllConnections();
          const closed = Promise.withResolvers();
          server.close(closed.resolve);
          await closed.promise;
        }
      `;
      execFile(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 10_000 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr, { cause: error }));
          else resolve();
        }
      );
      return promise;
    },
    catch: (cause) => cause
  })
);

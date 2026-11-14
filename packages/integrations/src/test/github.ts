import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Access from "../github/Access.js";
import * as Flows from "../github/Flows.js";
import * as Source from "../github/Source.js";

/**
 * GitHub for offline tests: the production GitHub source over an injected HTTP client that
 * answers in-process from a small world of installations, people and tokens, in the shapes the
 * probe was answered with (hand-written, never its output). Refusals follow the probe's table:
 * a mint for a repository outside the installation answers 422, a suspended installation 403, a
 * removed one 404, a deleted key 401. Nothing reaches the network.
 */

export interface Repository {
  readonly id: number;
  readonly name: string;
  readonly private?: boolean;
  readonly archived?: boolean;
}
export interface Installation {
  readonly id: number;
  readonly account: { readonly id: number; readonly login: string; readonly type: string };
  repositories: Array<Repository>;
  suspended?: boolean;
  permissions?: Record<string, string>;
}
export interface Person {
  readonly id: number;
  readonly login: string;
  /** Installations they can see. */
  readonly sees: Set<number>;
  /** Repositories GitHub says they administer. */
  readonly admin: Set<number>;
  /** Repositories they can see but whose listing carries no `permissions` at all. */
  readonly silent?: Set<number>;
}
export interface Request {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: string;
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The App this world knows: its key is the one tests configure the source with. */
export const app: Source.App = {
  id: "1001",
  slug: "patchy-cloud-test",
  clientId: "Iv23test",
  clientSecret: Redacted.make("test-secret"),
  privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString())
};

const json = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
const message = (status: number, text: string) => json(status, { message: text });

/** A world of installations and people, and what was minted and revoked in it. */
export const world = () => {
  const installations = new Map<number, Installation>();
  const people = new Map<string, Person>();
  const codes = new Map<
    string,
    { readonly person: string; readonly challenge: string; used: boolean }
  >();
  const userTokens = new Map<string, string>();
  const tokens = new Map<
    string,
    { readonly installationId: number; readonly ids: ReadonlyArray<number> | "all" }
  >();
  const revoked: Array<string> = [];
  const requests: Array<Request> = [];
  const answerAsWorld: (request: Request) => Response | Promise<Response> | undefined = () =>
    undefined;
  const state = {
    keyDeleted: false,
    /**
     * Answers before anything else, such as a limit answer, or a refusal held until a test lets
     * it go; undefined lets the world answer.
     */
    override: answerAsWorld,
    minted: 0
  };
  let serial = 0;

  const add = (installation: Installation) => {
    installations.set(installation.id, installation);
    return installation;
  };
  const person = (login: string, value: Person) => {
    people.set(login, value);
    return value;
  };
  /** GitHub's authorization page, as the person `login` finishes it: a code for the callback. */
  const authorize = (login: string, url: string) => {
    const authorizeUrl = new URL(url);
    const code = `code-${++serial}`;
    codes.set(code, {
      person: login,
      challenge: authorizeUrl.searchParams.get("code_challenge") ?? "",
      used: false
    });
    return { code, state: authorizeUrl.searchParams.get("state") ?? "" };
  };

  const jwtValid = (authorization: string | undefined) => {
    const [head, claims, signature] = (authorization ?? "").replace(/^Bearer /, "").split(".");
    if (head === undefined || claims === undefined || signature === undefined) return false;
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString()) as { iss?: string };
    return (
      payload.iss === app.clientId &&
      createVerify("RSA-SHA256")
        .update(`${head}.${claims}`)
        .verify(publicKey, Buffer.from(signature, "base64url"))
    );
  };
  const repositoryBody = (item: Repository, admin: boolean | undefined) => ({
    id: item.id,
    name: item.name,
    full_name: `owner/${item.name}`,
    private: item.private ?? true,
    archived: item.archived ?? false,
    disabled: false,
    default_branch: "main",
    ...(admin === undefined ? {} : { permissions: { admin, push: admin, pull: true } })
  });
  const installationBody = (item: Installation) => ({
    id: item.id,
    account: item.account,
    suspended_at: item.suspended === true ? "2026-11-14T10:00:00Z" : null,
    permissions: item.permissions ?? { ...Source.permissions }
  });
  const page = <A>(items: ReadonlyArray<A>, url: URL) => {
    const size = Number(url.searchParams.get("per_page") ?? "30");
    const at = Number(url.searchParams.get("page") ?? "1");
    return items.slice((at - 1) * size, at * size);
  };

  const handle = (request: Request): Response | Promise<Response> => {
    requests.push(request);
    const early = state.override(request);
    if (early !== undefined) return early;
    const { url, method } = request;
    const bearer = request.authorization?.replace(/^Bearer /, "") ?? "";
    if (url.origin === Source.WEB_URL && url.pathname === "/login/oauth/access_token") {
      const params = new URLSearchParams(request.body);
      const found = codes.get(params.get("code") ?? "");
      // A used code answers 200 with an error (shown); a wrong verifier, 400 and burns the code.
      if (found === undefined || found.used) return json(200, { error: "bad_verification_code" });
      found.used = true;
      const verifier = params.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== found.challenge)
        return json(400, { error: "invalid_grant" });
      const token = `ghu_${++serial}`;
      userTokens.set(token, found.person);
      return json(200, {
        access_token: token,
        refresh_token: "ghr_never_read",
        token_type: "bearer"
      });
    }
    if (url.origin !== Source.API_URL) return message(404, "Not Found");
    const path = url.pathname;
    if (method === "DELETE" && path === `/applications/${app.clientId}/token`) {
      const token = (JSON.parse(request.body) as { access_token: string }).access_token;
      revoked.push(token);
      userTokens.delete(token);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && path === "/installation/token") {
      revoked.push(bearer);
      tokens.delete(bearer);
      return new Response(null, { status: 204 });
    }
    if (path === "/user" || path.startsWith("/user/")) {
      const login = userTokens.get(bearer);
      const who = login === undefined ? undefined : people.get(login);
      if (who === undefined) return message(401, "Bad credentials");
      if (path === "/user") return json(200, { id: who.id, login: who.login });
      if (path === "/user/installations")
        return json(200, {
          total_count: who.sees.size,
          installations: [...who.sees].flatMap((id) => {
            const found = installations.get(id);
            return found === undefined ? [] : [installationBody(found)];
          })
        });
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      const found = match === null ? undefined : installations.get(Number(match[1]));
      if (found === undefined || !who.sees.has(found.id)) return message(404, "Not Found");
      return json(200, {
        total_count: found.repositories.length,
        repositories: page(found.repositories, url).map((item) =>
          repositoryBody(
            item,
            who.silent?.has(item.id) === true ? undefined : who.admin.has(item.id)
          )
        )
      });
    }
    if (path.startsWith("/app/")) {
      if (state.keyDeleted || !jwtValid(request.authorization))
        return message(401, "A JSON web token could not be decoded");
      const read = /^\/app\/installations\/(\d+)$/.exec(path);
      if (read !== null && method === "GET") {
        const found = installations.get(Number(read[1]));
        return found === undefined ? message(404, "Not Found") : json(200, installationBody(found));
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (mint !== null && method === "POST") {
        const found = installations.get(Number(mint[1]));
        if (found === undefined) return message(404, "Not Found");
        if (found.suspended === true) return message(403, "This installation has been suspended");
        const asked = JSON.parse(request.body) as {
          repository_ids?: ReadonlyArray<number>;
          permissions?: Record<string, string>;
        };
        const held = found.permissions ?? Source.permissions;
        if (
          Object.entries(asked.permissions ?? {}).some(
            ([name, level]) => held[name as keyof typeof held] !== level
          )
        )
          return message(422, "The permissions requested are not granted to this installation.");
        const inside = new Set(found.repositories.map((item) => item.id));
        if ((asked.repository_ids ?? []).some((id) => !inside.has(id)))
          return message(
            422,
            "There is at least one repository that does not exist or is not accessible to the parent installation."
          );
        const token = `ghs_${++serial}`;
        state.minted++;
        tokens.set(token, { installationId: found.id, ids: asked.repository_ids ?? "all" });
        return json(201, {
          token,
          expires_at: "2099-01-01T00:00:00Z",
          permissions: asked.permissions
        });
      }
      return message(404, "Not Found");
    }
    if (path === "/installation/repositories") {
      const held = tokens.get(bearer);
      const found = held === undefined ? undefined : installations.get(held.installationId);
      if (held === undefined || found === undefined) return message(401, "Bad credentials");
      if (found.suspended === true) return message(403, "This installation has been suspended");
      const reached = found.repositories.filter(
        (item) => held.ids === "all" || held.ids.includes(item.id)
      );
      return json(200, {
        total_count: reached.length,
        repositories: page(reached, url).map((item) => repositoryBody(item, undefined))
      });
    }
    return message(404, "Not Found");
  };

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const body = yield* Effect.promise(() => web.text());
      const answer = yield* Effect.promise(async () =>
        handle({
          method: request.method,
          url: new URL(web.url),
          authorization: request.headers.authorization,
          body
        })
      );
      return HttpClientResponse.fromWeb(request, answer);
    })
  );
  /** The production source, seam and flows, configured with `app`, over this world. */
  const layer = Layer.mergeAll(Access.layer, Flows.layer).pipe(
    Layer.provideMerge(
      Layer.effect(Source.Source, Source.makeWith(Option.some(app))).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
      )
    )
  );
  return {
    installations,
    people,
    tokens,
    revoked,
    requests,
    state,
    add,
    person,
    authorize,
    layer
  };
};

/**
 * GitHub on an instance whose App isn't configured: nothing about it is offered. It brings its own
 * keyring, so a fixture that has a database and `Cryptography` can add it beside anything else.
 */
export const unconfigured = Layer.mergeAll(Access.layer, Flows.layer).pipe(
  Layer.provideMerge(
    Layer.effect(Source.Source, Source.makeWith(Option.none())).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("GitHub isn't configured here"))
        )
      )
    )
  ),
  Layer.provide(
    CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`))
  )
);

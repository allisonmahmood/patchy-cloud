import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { escapeHtml } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as CommunityConnections from "./CommunityConnections.js";
import * as Pieces from "./Pieces.js";
import * as View from "./CommunityView.js";
import { isKey, type Key } from "./catalog.js";

export const path = View.path;
const decodeCredentials = Schema.decodeUnknownEffect(Pieces.Credentials);
const selected = Effect.gen(function* () {
  const { piece } = yield* HttpRouter.params;
  if (!piece || !isKey(piece)) return yield* new CommunityConnections.Refused({ code: "missing" });
  return piece;
});
const render = Effect.fn("CommunityPages.render")(function* (
  key?: Key,
  notice?: string,
  status = 200,
  result?: unknown
) {
  const viewer = yield* RequireSession.Viewer;
  if (viewer.role !== "admin")
    return yield* new CommunityConnections.Refused({ code: "forbidden" });
  const session = yield* Session.Session;
  const pieces = yield* Pieces.Pieces;
  const info = key ? pieces.infos.find((info) => info.key === key) : undefined;
  if (key && !info) return yield* new CommunityConnections.Refused({ code: "missing" });
  let body = View.catalogue(pieces.infos);
  if (info) {
    const rows = yield* (yield* CommunityConnections.CommunityConnections).list(info.key);
    const logs = yield* RuntimeLog.RuntimeLog;
    const calls = new Map<string, ReadonlyArray<RuntimeLog.Call>>();
    for (const row of rows)
      calls.set(
        row.id,
        yield* logs.recent({ companyId: viewer.company.id, connectionId: row.id, limit: 5 })
      );
    body = View.provider({
      info,
      company: viewer.company.name,
      rows,
      calls,
      notice,
      status,
      result
    });
  }
  return pageResponse(
    {
      title: info ? `${info.displayName} connections` : "Connector catalog",
      status,
      app: { viewer, section: "connections" },
      body
    },
    session
  );
});

const readForm = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const entries = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(32768)),
    Effect.map((params) =>
      Array.from(
        params,
        ([name, value]) =>
          [name, Redacted.isRedacted(value) ? Redacted.value(value) : value] as const
      )
    ),
    Effect.catchTags({
      HttpServerError: () => Effect.fail(new CommunityConnections.Refused({ code: "invalid" }))
    })
  );
  const form = new Map(entries);
  if (form.size !== entries.length)
    return yield* new CommunityConnections.Refused({ code: "invalid" });
  return form;
});

const submit = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  if (viewer.role !== "admin")
    return yield* new CommunityConnections.Refused({ code: "forbidden" });
  const key = yield* selected;
  const store = yield* CommunityConnections.CommunityConnections;
  const params = yield* HttpRouter.params;
  const action = params.action ?? "connect";
  const id = params.id ?? "";
  if (params.operation && action !== "run")
    return yield* new CommunityConnections.Refused({ code: "missing" });
  if (action === "run") {
    const form = yield* readForm;
    if ([...form.keys()].some((name) => !name.startsWith("input.")))
      return yield* new CommunityConnections.Refused({ code: "invalid" });
    return yield* render(
      key,
      "Action completed.",
      200,
      yield* store.run(
        key,
        id,
        params.operation,
        Object.fromEntries([...form].map(([name, value]) => [name.slice("input.".length), value]))
      )
    );
  }
  if (action === "disconnect") yield* store.disconnect(key, id);
  else if (action === "delete") yield* store.delete(key, id);
  else if (action === "connect") {
    const fields = (yield* Pieces.Pieces).infos.find((info) => info.key === key)!.fields;
    const form = yield* readForm;
    if (
      [...form].some(
        ([name]) =>
          name !== "handle" && !fields.some((field) => name === `credential.${field.name}`)
      )
    )
      return yield* new CommunityConnections.Refused({ code: "invalid" });
    const credentials = yield* decodeCredentials(
      Object.fromEntries(
        fields.flatMap((field) =>
          form.has(`credential.${field.name}`)
            ? [[field.name, form.get(`credential.${field.name}`)!]]
            : []
        )
      )
    ).pipe(
      Effect.catchTags({
        SchemaError: () => Effect.fail(new CommunityConnections.Refused({ code: "invalid" }))
      })
    );
    yield* store.connect({
      key,
      handle: form.get("handle") ?? "",
      credentials: Redacted.make(credentials),
      ...(id ? { id } : {})
    });
  } else return yield* new CommunityConnections.Refused({ code: "missing" });
  return HttpServerResponse.redirect(View.providerPath(key), {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

const refusal = (message: string, status: number) =>
  pageResponse({ title: "Connection unavailable", body: `<p>${escapeHtml(message)}</p>`, status });
const recover = Effect.fn("CommunityPages.recover")(function* (message: string, status: number) {
  const key = yield* selected;
  return yield* render(key, message, status);
});
const errors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, CommunityConnections.Failure, R>
) =>
  effect.pipe(
    Effect.catchTags({
      CommunityRefused: (error) =>
        error.code === "forbidden" || error.code === "missing"
          ? Effect.succeed(refusal(error.message, error.status))
          : recover(error.message, error.status),
      PieceFailure: (error) => recover(error.message, 502),
      CredentialEncryptionFailed: () => recover("The credentials could not be saved.", 503),
      CredentialDecryptionFailed: () =>
        recover("The credentials are unavailable. Replace them and try again.", 503),
      SqlError: () => Effect.succeed(refusal("Try again.", 503))
    })
  );
const serve = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, CommunityConnections.Failure, R>
) =>
  RequireSession.withViewer(errors(effect)).pipe(
    Effect.catchTags({
      CommunityRefused: (error) => Effect.succeed(refusal(error.message, error.status)),
      SessionError: () => Effect.succeed(refusal("Sign-in is unavailable. Try again.", 502)),
      SqlError: () => Effect.succeed(refusal("Connection service is unavailable. Try again.", 503))
    })
  );

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", path, serve(render()));
    yield* router.add(
      "GET",
      `${path}/:piece`,
      serve(Effect.flatMap(selected, (key) => render(key)))
    );
    for (const target of [
      `${path}/:piece`,
      `${path}/:piece/:id/:action`,
      `${path}/:piece/:id/:action/:operation`
    ] as const)
      yield* router.add("POST", target, RequireSession.sameOrigin(serve(submit)));
  })
);

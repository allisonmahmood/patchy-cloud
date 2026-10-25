import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as CommunityConnections from "./CommunityConnections.js";
import { catalog } from "./Pieces.js";

export const path = "/company/connections/community/slack";
const attr = escapeAttribute;
const post = (id: string, action: string, label: string) =>
  `<form method="post" action="${path}/${attr(id)}/${action}"><button class="btn btn-quiet" type="submit">${label}</button></form>`;
const tokenField = `<label class="field-label" for="token">Bot token</label><input class="field" id="token" name="token" type="password" autocomplete="off" required placeholder="xoxb-…"><p class="field-hint">Use a token from an existing installed Slack app with channels:read.</p>`;

const render = (notice = "", status = 200, result?: unknown) =>
  Effect.gen(function* () {
    const viewer = yield* RequireSession.Viewer;
    const session = yield* Session.Session;
    const store = yield* CommunityConnections.CommunityConnections;
    const logs = yield* RuntimeLog.RuntimeLog;
    const rows = yield* store.list;
    const cards: string[] = [];
    for (const row of rows) {
      const calls = yield* logs.recent({
        companyId: viewer.company.id,
        connectionId: row.id,
        limit: 5
      });
      const history = calls.length
        ? `<h3>Recent calls</h3><ul class="list list-compact">${calls.map((call) => `<li>${escapeHtml(call.op)} · ${escapeHtml(call.outcome)} · ${escapeHtml(call.at.toISOString())}</li>`).join("")}</ul>`
        : "<p>No calls yet.</p>";
      cards.push(`<section class="section"><h2 class="section-heading">slack/${escapeHtml(row.handle)}</h2><p>${escapeHtml(row.status)} · <code>${escapeHtml(row.id)}</code></p>
      ${row.status === "connected" ? `<form method="post" action="${path}/${attr(row.id)}/run"><button class="btn btn-primary" type="submit">${catalog.slack.actionLabel}</button></form>` : "<p>The saved token has been removed. Enter a token below to reconnect.</p>"}
      <details><summary>${row.status === "connected" ? "Replace token" : "Reconnect"}</summary><form method="post" action="${path}/${attr(row.id)}/connect"><input type="hidden" name="handle" value="${attr(row.handle)}">${tokenField.replaceAll('id="token"', `id="token-${attr(row.id)}"`).replaceAll('for="token"', `for="token-${attr(row.id)}"`)}<button class="btn" type="submit">Test and save token</button></form></details>
      <div class="actions">${row.status === "connected" ? post(row.id, "disconnect", "Disconnect and remove token") : post(row.id, "delete", "Delete connection")}</div>${history}</section>`);
    }
    return pageResponse(
      {
        title: "Slack connections",
        status,
        app: { viewer, section: "connections" },
        body: `<p><a href="/company/connections">Connections</a> / Local prototype</p><p>Connect Slack for <strong>${escapeHtml(viewer.company.name)}</strong>. Paste your bot token here; Patchy keeps it encrypted.</p>
      <p class="supporting-text">Local prototype · Real Slack requests · Public channel names only · No messages are sent</p>
      ${notice ? `<div class="note ${status >= 400 ? "note-refused" : "note-ok"}" role="${status >= 400 ? "alert" : "status"}">${escapeHtml(notice)}</div>` : ""}
      ${result === undefined ? "" : `<section class="section"><h2 class="section-heading">Slack result</h2><pre class="code-panel">${escapeHtml(JSON.stringify(result, null, 2))}</pre></section>`}
      ${cards.join("")}
      <section class="section"><h2 class="section-heading">Connect Slack</h2><form method="post" action="${path}">
      <label class="field-label" for="handle">Connection handle</label><input class="field" id="handle" name="handle" value="workspace" minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" required>${tokenField}<div class="actions"><button class="btn btn-primary" type="submit">Test and connect</button></div></form></section>`
      },
      session
    );
  });

const submit = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  if (viewer.role !== "admin")
    return yield* new CommunityConnections.Refused({ code: "forbidden" });
  const store = yield* CommunityConnections.CommunityConnections;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const action = params.action ?? "connect";
  const id = params.id ?? "";
  if (action === "run") return yield* render("Slack action completed.", 200, yield* store.run(id));
  if (action === "disconnect") yield* store.disconnect(id);
  else if (action === "delete") yield* store.delete(id);
  else if (action === "connect") {
    const form = yield* request.urlParamsBody.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(8192)),
      Effect.map(
        (params) =>
          new Map(
            Array.from(
              params,
              ([key, value]) =>
                [key, Redacted.isRedacted(value) ? Redacted.value(value) : value] as const
            )
          )
      ),
      Effect.catchTags({
        HttpServerError: () => Effect.fail(new CommunityConnections.Refused({ code: "invalid" }))
      })
    );
    yield* store.connect({
      handle: form.get("handle") ?? "",
      token: Redacted.make(form.get("token") ?? ""),
      ...(id ? { id } : {})
    });
  } else return yield* new CommunityConnections.Refused({ code: "missing" });
  return HttpServerResponse.redirect(path, {
    status: 303,
    headers: { "cache-control": "private, no-store" }
  });
});

const errors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, CommunityConnections.Failure, R>
) =>
  effect.pipe(
    Effect.catchTags({
      CommunityRefused: (error) =>
        error.code === "forbidden"
          ? Effect.succeed(
              pageResponse({
                title: "Admin access required",
                body: `<p>${escapeHtml(error.message)}</p>`,
                status: 403
              })
            )
          : render(error.message, error.status),
      PieceFailure: (error) => render(error.message, 502),
      CredentialEncryptionFailed: () => render("The token could not be saved.", 503),
      CredentialDecryptionFailed: () =>
        render("The token is unavailable. Replace it and try again.", 503),
      SqlError: () =>
        Effect.succeed(
          pageResponse({
            title: "Connection service unavailable",
            body: "<p>Try again.</p>",
            status: 503
          })
        )
    })
  );

const serve = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, CommunityConnections.Failure, R>
) =>
  RequireSession.withViewer(errors(effect)).pipe(
    Effect.catchTags({
      CommunityRefused: (error) =>
        Effect.succeed(
          pageResponse({
            title: "Connection unavailable",
            body: `<p>${escapeHtml(error.message)}</p>`,
            status: error.status
          })
        ),
      SessionError: () =>
        Effect.succeed(
          pageResponse({ title: "Sign-in unavailable", body: "<p>Try again.</p>", status: 502 })
        ),
      SqlError: () =>
        Effect.succeed(
          pageResponse({
            title: "Connection service unavailable",
            body: "<p>Try again.</p>",
            status: 503
          })
        )
    })
  );

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", path, serve(render()));
    for (const target of [path, `${path}/:id/:action`] as const)
      yield* router.add("POST", target, RequireSession.sameOrigin(serve(submit)));
  })
);

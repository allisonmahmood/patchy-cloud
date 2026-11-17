/** Throwaway #1465 prototype. Mounted only with dev personas; state dies with the server. */
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import {
  button,
  detailPage,
  disclosure,
  escapeHtml,
  facts,
  field,
  input,
  textarea,
  linkButton,
  notice,
  section
} from "@patchy/core";
import type { Users } from "@patchy/companies";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ConnectFrame from "../ConnectFrame.js";

const path = "/settings/integrations/connect/notion-prototype";
const work = "/settings/integrations/notion-prototype";
const Form = Schema.Record(Schema.String, Schema.String);
type Form = typeof Form.Type;
const walks: Record<string, readonly Form[]> = {
  Tasks: ["list", "get", "create", "update", "trash", "restore"].map((op) => ({
    op,
    title: op === "update" ? "Prototype reviewed" : "Prototype follow-up",
    status: op === "update" ? "Ready" : "Backlog",
    assignee: "person-srikar"
  })),
  Wiki: [
    { op: "read", page: "wiki-1" },
    { op: "edit", page: "wiki-1", markdown: initialWikiEdit() },
    { op: "read", page: "wiki-1" }
  ],
  Access: ["read", "unshare", "read", "edit"].map((op) => ({
    op,
    page: "page-1",
    markdown: "# Must be refused"
  }))
};
function initialWikiEdit() {
  return "# Handbook\n\n**Edited text** and [a link](https://patchyhq.com).";
}
type Result = Record<string, unknown>;
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const initialMarkdown =
  '# Handbook\n\n> Build complex things simply.\n\n- [ ] Review\n\n<unknown id="embed-1" />';
const text = (content: string) => [{ type: "text", text: { content } }];
const pretty = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;

// Same connect frame as Attio/PostHog, with only the Notion-specific words and fields.
const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Prepare the probe workspace",
    steps: [
      "Use prototype_notion for the local fake, or an internal connection token for #936's isolated workspace. Share its Tasks database and probe page with the connection."
    ]
  },
  paste: {
    title: "Paste its token",
    fields: [{ kind: "secret", name: "key", field: "key", label: "Internal connection token" }]
  },
  name: { example: "probe", describe: "Notion prototype workspace" },
  once: {
    reads: "the data sources and pages shared with this connection",
    devReads: false,
    also: ["This prototype can change Tasks and page markdown"],
    cannot: ["This connection is kept only until the local server stops"],
    caveat:
      "Use only the isolated probe workspace. Real writes can notify people and run Notion automations."
  }
};

/** A provider double lives behind the server adapter, so browser actions never mutate probe data. */
function fakeProvider() {
  let sequence = 1;
  const rows: Result[] = [
    {
      id: "task-1",
      url: "https://notion.so/task-1",
      title: "Draft launch notes",
      status: "Backlog",
      assignee: "Allison",
      in_trash: false
    }
  ];
  const pages = new Map([
    ["page-1", "# Field notes\n\n**Bold** text."],
    ["wiki-1", initialMarkdown]
  ]);
  const shared = new Set(pages.keys());
  return async (route: string, method: string, body: Result): Promise<Result> => {
    const parts = route.split("/");
    const id = parts[1] ?? "";
    if (route === "users/me")
      return { bot: { owner: { type: "workspace" }, workspace_name: "Local Notion probe" } };
    if (route === "search")
      return {
        results: [
          {
            id: "probe-tasks",
            title: text("Tasks"),
            properties: {
              Name: { id: "title", type: "title" },
              Status: { id: "status", type: "status" },
              Assignee: { id: "people", type: "people" }
            }
          }
        ]
      };
    if (route.endsWith("/query"))
      return { results: rows.filter((row) => !row.in_trash), has_more: false };
    if (route.endsWith("/sharing")) {
      if (body.shared) shared.add(id);
      else shared.delete(id);
      return { id, shared: shared.has(id) };
    }
    if (route.endsWith("/markdown")) {
      if (!shared.has(id)) throw new Error("not_found: this page is missing or no longer shared.");
      if (method === "PATCH") pages.set(id, String((body.replace_content as Result).new_str));
      return {
        id,
        markdown: pages.get(id),
        truncated: false,
        unknown_block_ids: pages.get(id)?.includes("<unknown") ? ["embed-1"] : []
      };
    }
    if (route === "pages") {
      const id = `created-${++sequence}`;
      const parent = body.parent as Result;
      if (parent.page_id) {
        pages.set(id, String(body.markdown ?? ""));
        shared.add(id);
      } else
        rows.push({
          id,
          url: `https://notion.so/${id}`,
          properties: body.properties,
          in_trash: false
        });
      return { id, url: `https://notion.so/${id}` };
    }
    const row = rows.find((row) => row.id === id);
    if (!row) throw new Error("not_found: this row is missing.");
    if (method === "PATCH") Object.assign(row, body);
    return { ...row };
  };
}

/** Fixed upstream host and version; tokens stay in this closure and writes are never retried. */
function provider(token: string, http: HttpClient.HttpClient) {
  const fake = fakeProvider();
  return (route: string, method: "GET" | "POST" | "PATCH", body: Result) =>
    token === "prototype_notion"
      ? Effect.tryPromise({
          try: () => fake(route, method, body),
          catch: (cause) => (cause instanceof Error ? cause.message : "Fake Notion refused.")
        })
      : Effect.gen(function* () {
          const base = HttpClientRequest.make(method)(`https://api.notion.com/v1/${route}`).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${token}`,
              "Notion-Version": "2026-03-11"
            })
          );
          const request = method === "GET" ? base : HttpClientRequest.bodyJsonUnsafe(base, body);
          const response = yield* http.execute(request);
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              response.status === 404
                ? "not_found: this page is missing or no longer shared."
                : `${response.status}: Notion refused. Read before retrying a write.`
            );
          return decodeObject(yield* response.json);
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError((error) =>
            typeof error === "string"
              ? error
              : "Notion did not complete this call. Read before retrying a write."
          )
        );
}

type Probe = {
  walk: string;
  step: number;
  send: ReturnType<typeof provider>;
  fake: boolean;
  handle: string;
  schema: Result;
  source: string;
  task: string;
  page: string;
  last: unknown;
  request: unknown;
  error: string;
};

/** Single prototype adapter: maps fixed task/page operations to provider requests. */
const call = Effect.fn("NotionPrototype.call")(function* (probe: Probe, form: Form) {
  const id = form.id || probe.task;
  const properties = {
    ...(form.title ? { Name: { title: text(form.title) } } : {}),
    ...(form.status ? { Status: { status: { name: form.status } } } : {}),
    ...(form.assignee ? { Assignee: { people: [{ id: form.assignee }] } } : {})
  };
  let route = `pages/${encodeURIComponent(id)}`,
    method: "GET" | "POST" | "PATCH" = "GET",
    body: Result = {};
  switch (form.op) {
    case "list":
      route = `data_sources/${encodeURIComponent(probe.source)}/query`;
      method = "POST";
      break;
    case "create":
      route = "pages";
      method = "POST";
      body = { parent: { data_source_id: probe.source }, properties };
      break;
    case "update":
      method = "PATCH";
      body = { properties };
      break;
    case "trash":
    case "restore":
      method = "PATCH";
      body = { in_trash: form.op === "trash" };
      break;
    case "read":
      route = `pages/${encodeURIComponent(form.page || probe.page)}/markdown`;
      break;
    case "edit":
      route = `pages/${encodeURIComponent(form.page || probe.page)}/markdown`;
      method = "PATCH";
      body = { type: "replace_content", replace_content: { new_str: form.markdown } };
      break;
    case "child":
      route = "pages";
      method = "POST";
      body = {
        parent: { page_id: form.page || probe.page },
        properties: { title: { title: text(form.childTitle || "Child page") } },
        markdown: form.markdown || "# Child page"
      };
      break;
    case "unshare":
    case "reshare":
      if (!probe.fake)
        return yield* Effect.fail("Change sharing in Notion, then retry the read or edit here.");
      route = `pages/${encodeURIComponent(form.page || probe.page)}/sharing`;
      method = "PATCH";
      body = { shared: form.op === "reshare" };
      break;
    case "get":
      break;
    default:
      return yield* Effect.fail("Choose a prototype operation.");
  }
  probe.request = { operation: form.op, method, route, body };
  const result = yield* probe.send(route, method, body);
  if (form.op === "create" && typeof result.id === "string") probe.task = result.id;
  if (form.page) probe.page = form.page;
  return result;
});

function workspace(probe: Probe) {
  const entry = (name: string, label: string, value = "") =>
    field({ id: name, label, control: (aria) => input(aria, { name, value }) });
  const actions = (items: readonly string[]) =>
    items.map((op) => button(op, { name: "op", value: op })).join(" ");
  return detailPage({
    title: `notion/${probe.handle}`,
    parent: { label: "Integrations", href: "/settings/integrations" },
    mark: "",
    meta: [probe.fake ? "Local fake provider · server state" : "Isolated Notion workspace"],
    actions: linkButton("Connect again / reset", path),
    main:
      section({
        title: "Discovered schema",
        body: disclosure("Tasks: title, status and assignee", pretty(probe.schema))
      }) +
      section({
        title: "Tasks",
        body: `<form method="post" action="${work}">${entry("id", "Task ID", probe.task)}${entry("title", "Title", "Prototype follow-up")}${entry("status", "Status", "Backlog")}${entry("assignee", "Assignee's Notion user ID")}<div class="cluster">${actions(["list", "get", "create", "update", "trash", "restore"])}</div></form>`
      }) +
      section({
        title: "Pages and wiki",
        body: `<form method="post" action="${work}">${entry("page", "Page ID", probe.page)}${entry("childTitle", "Child page title", "Prototype child")}${field({ id: "markdown", label: "Markdown", control: (aria) => textarea(aria, { name: "markdown", value: initialMarkdown + "\n\n**Prototype edit**" }) })}<div class="cluster">${actions(["read", "edit", "child", "unshare", "reshare"])}</div></form>`
      }),
    aside:
      section({
        title: "Walkthroughs",
        body: `<form method="post" action="${work}"><div class="cluster">${Object.keys(walks)
          .map((name) => button(name, { name: "walk", value: name }))
          .join(
            " "
          )}</div>${probe.walk ? `<p>${escapeHtml(probe.walk)}: ${probe.step} / ${walks[probe.walk]?.length ?? 0} steps</p>${probe.step < (walks[probe.walk]?.length ?? 0) ? button("Run next step", { name: "next", value: "yes", kind: "primary" }) : "<p>Walkthrough complete.</p>"}` : "<p>Choose a walkthrough to reset the local fake.</p>"}</form>`
      }) +
      section({
        title: "Current state",
        body:
          facts([
            ["Data source", probe.source],
            ["Task", probe.task],
            ["Page", probe.page]
          ]) +
          (probe.error
            ? notice({ tone: "danger", title: "Call refused", body: escapeHtml(probe.error) })
            : "") +
          pretty({ request: probe.request, result: probe.last })
      })
  });
}

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", Session.Session | Users.Users | SqlClient.SqlClient>
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const probes = new Map<string, Probe>();
    const serve = Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const session = yield* Session.Session;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (viewer.company.handle !== "brightline" || viewer.role !== "admin")
        return HttpServerResponse.empty({ status: 403 });
      let probe = probes.get(viewer.company.id);
      let error = "";
      if (request.method === "POST") {
        const form = yield* HttpServerRequest.schemaBodyUrlParams(Form);
        const outcome = yield* Effect.gen(function* () {
          if (request.url.split("?")[0] === path) {
            const send = provider(form.key ?? "", http);
            const self = yield* send("users/me", "GET", {});
            if ((self.bot as { owner?: { type?: string } })?.owner?.type !== "workspace")
              return yield* Effect.fail("Use an internal connection owned by the workspace.");
            const schema = yield* send("search", "POST", {
              filter: { property: "object", value: "data_source" },
              page_size: 100
            });
            const source = (schema.results as { id: string }[])?.[0]?.id;
            if (!source)
              return yield* Effect.fail(
                "Share the probe Tasks database directly with this connection."
              );
            probe = {
              send,
              walk: "",
              step: 0,
              fake: form.key === "prototype_notion",
              handle: form.handle || "probe",
              schema,
              source,
              task: "task-1",
              page: "page-1",
              last: self,
              request: "Connected and discovered",
              error: ""
            };
            probes.set(viewer.company.id, probe);
          } else {
            if (!probe) return yield* Effect.fail("Connect the probe first.");
            if (form.walk && walks[form.walk]) {
              if (!probe.fake)
                return yield* Effect.fail(
                  "Guided resets use the local fake. Use free play for the live probe."
                );
              probe.send = provider("prototype_notion", http);
              probe.task = "task-1";
              probe.page = "page-1";
              probe.walk = form.walk;
              probe.step = 0;
              probe.error = "";
              probe.last = "Reset to known probe content";
              return;
            }
            const action = form.next ? walks[probe.walk]?.[probe.step] : form;
            if (!action) return yield* Effect.fail("Choose a walkthrough first.");
            if (form.next) probe.step++;
            if (form.id) probe.task = form.id;
            probe.error = "";
            probe.last = yield* call(probe, action);
          }
        }).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          error = outcome.failure;
          if (probe) {
            probe.error = error;
            probe.last = null;
          }
        }
      }
      const content =
        probe && request.url.split("?")[0] !== path
          ? workspace(probe)
          : ConnectFrame.render({
              integration: { key: "notion-prototype", label: "Notion prototype", mark: "N" },
              spec: connect,
              submitted: {},
              back: "/settings/integrations",
              ...(error
                ? { notice: { message: error, code: "prototype_refused", status: 422 } }
                : {})
            });
      if (request.method === "POST" && probe && (request.url.split("?")[0] !== path || !error))
        return HttpServerResponse.redirect(work, { status: 303 });
      return pageResponse(
        { title: "Notion prototype", ...content, app: { viewer, section: "integrations" } },
        session
      );
    });
    for (const route of [path, work] as const) {
      yield* router.add(
        "GET",
        route,
        RequireSession.withViewer(serve).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))
        )
      );
      yield* router.add(
        "POST",
        route,
        RequireSession.sameOrigin(RequireSession.withViewer(serve)).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))
        )
      );
    }
  })
).pipe(Layer.provide(FetchHttpClient.layer));

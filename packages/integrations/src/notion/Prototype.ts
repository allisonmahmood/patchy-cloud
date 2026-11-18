/** Throwaway live Notion prototype. Dev personas only; credentials and state die with the server. */
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import {
  button,
  detailPage,
  disclosure,
  escapeHtml,
  facts,
  field,
  input,
  linkButton,
  notice,
  section,
  select,
  textarea
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
import * as Semaphore from "effect/Semaphore";
import * as ConnectFrame from "../ConnectFrame.js";
import type { Row } from "../ConnectionsView.js";

const path = "/settings/integrations/connect/notion-prototype";
const work = "/settings/integrations/notion-prototype";
const Form = Schema.Record(Schema.String, Schema.String);
type Form = typeof Form.Type;
type Result = Record<string, unknown>;
const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const text = (content: string) => [{ type: "text", text: { content } }];
const pretty = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
const markdown =
  "# Handbook\n\n**Bold**, *italic*, `code` and [a link](https://patchyhq.com).\n\n- [ ] Review\n\n> Build complex things simply.";
type Item = {
  id: string;
  type?: string;
  name?: string;
  properties?: Record<string, { title?: { plain_text: string }[] }>;
};
type Action =
  | { op: "list" }
  | { op: "get" | "trash" | "restore"; task: string }
  | { op: "create"; title: string }
  | { op: "update"; task: string; title: string; status: string; assignee: string }
  | { op: "read"; page: string }
  | { op: "edit"; page: string; markdown: string }
  | { op: "child"; markdown: string };
type Step = { op: Action["op"] | "pause" | "wiki-ready"; label: string; denied?: boolean };
const walks: Record<string, Step[]> = {
  Tasks: [
    { op: "list", label: "List tasks" },
    { op: "get", label: "Open the seed task" },
    { op: "create", label: "Create a task" },
    { op: "update", label: "Change title, status and assignee" },
    { op: "get", label: "Check changed fields" },
    { op: "trash", label: "Trash the task" },
    { op: "list", label: "Check it left the list" },
    { op: "restore", label: "Restore the task" },
    { op: "get", label: "Check the restored task" }
  ],
  Wiki: [
    { op: "wiki-ready", label: "I turned Handbook into a wiki — continue" },
    { op: "read", label: "Read the handbook" },
    { op: "edit", label: "Edit its markdown" },
    { op: "read", label: "Reread and compare formatting" }
  ],
  Access: [
    { op: "read", label: "Read the access page" },
    { op: "pause", label: "Remove Testtoken access in Notion" },
    { op: "read", label: "Verify reading is refused", denied: true },
    { op: "edit", label: "Verify editing is refused", denied: true }
  ]
};

class Refusal extends Schema.TaggedError<Refusal>()("NotionPrototypeRefusal", {
  status: Schema.Number,
  code: Schema.String
}) {
  get message() {
    return this.status === 404
      ? "Notion cannot find this page or the connection no longer has access (404)."
      : `Notion refused this call (${this.status}, ${this.code}). Check the current state before retrying a write.`;
  }
}
type Probe = {
  handle: string;
  send: (
    route: string,
    method?: "GET" | "POST" | "PATCH",
    body?: Result
  ) => Effect.Effect<Result, Refusal | string>;
  root: string;
  source: string;
  seed: string;
  task: string;
  wiki: string;
  access: string;
  child: string;
  page: string;
  schema: Result;
  people: Item[];
  statuses: string[];
  assignee: string;
  walk: string;
  step: number;
  walkTask: string;
  walkMarkdown?: string;
  before: string;
  loaded: string;
  draft: string;
  url: string;
  request: unknown;
  last: unknown;
  error: string;
  history: string[];
};
// Shared only by the local prototype route and its Integrations listing.
const probes = new Map<string, Probe>();
export const connectionFor = (company: string): Row | undefined => {
  const probe = probes.get(company);
  return probe
    ? {
        id: "notion-prototype",
        integration: { key: "notion", label: "Notion", mark: "N" },
        handle: probe.handle,
        description: "Tasks and pages",
        source: "Patchy prototype test",
        status: "connected",
        tag: "Prototype",
        href: work,
        usedBy: [],
        olderVersions: 0,
        retired: 0,
        deleted: 0,
        disabled: 0,
        declaredBy: [],
        declared: false
      }
    : undefined;
};
const isRefusal = Schema.is(Refusal);
const refusalMessage = (failure: Refusal | string) =>
  typeof failure === "string" ? failure : failure.message;
const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Share the test page",
    steps: [
      "Share exactly one page named Patchy prototype test with your internal connection. Connecting prepares Tasks, Handbook and Access probe beneath it."
    ]
  },
  paste: {
    title: "Paste its token",
    fields: [{ kind: "secret", name: "key", field: "key", label: "Internal connection token" }]
  },
  name: { example: "probe", describe: "Notion prototype workspace" },
  once: {
    reads: "the shared test page",
    devReads: false,
    also: ["Creates and edits test content under Patchy prototype test"],
    cannot: ["The local server forgets this token when it stops"]
  }
};

/** Discover existing scratch fixtures before creating anything under the named test root. */
const prepare = Effect.fn("NotionPrototype.prepare")(function* (p: Probe) {
  const found = yield* p.send("search", "POST", {
    query: "Patchy prototype test",
    filter: { property: "object", value: "page" },
    page_size: 100
  });
  const roots = (found.results as Item[]).filter((page) =>
    Object.values(page.properties ?? {}).some(
      (prop) => prop.title?.map((t) => t.plain_text).join("") === "Patchy prototype test"
    )
  );
  if (found.has_more || roots.length !== 1)
    return yield* Effect.fail(
      "Share exactly one page named Patchy prototype test with this connection, then connect again."
    );
  p.root = roots[0]!.id;
  const children = yield* p.send(`blocks/${p.root}/children?page_size=100`);
  if (children.has_more) return yield* Effect.fail("Keep the prototype root below 100 children.");
  const blocks = children.results as {
    id: string;
    child_page?: { title: string };
    child_database?: { title: string };
  }[];
  for (const name of ["Handbook", "Access probe"]) {
    const existing = blocks.filter((b) => b.child_page?.title === name);
    if (existing.length > 1)
      return yield* Effect.fail(`Keep only one ${name} fixture under the test page.`);
    let id = existing[0]?.id;
    if (!id) {
      const page = yield* p.send("pages", "POST", {
        parent: { page_id: p.root },
        properties: { title: { title: text(name) } },
        markdown
      });
      id = String(page.id);
      if (name === "Handbook")
        yield* p.send(`blocks/${id}/children`, "PATCH", {
          children: [
            { object: "block", type: "bookmark", bookmark: { url: "https://patchyhq.com" } },
            { object: "block", type: "embed", embed: { url: "https://example.com" } }
          ]
        });
    }
    if (name === "Handbook") p.wiki = id;
    else p.access = id;
  }
  const databases = blocks.filter((b) => b.child_database?.title === "Tasks");
  if (databases.length > 1)
    return yield* Effect.fail("Keep only one Tasks database under the test page.");
  const database = databases[0]
    ? yield* p.send(`databases/${databases[0].id}`)
    : yield* p.send("databases", "POST", {
        parent: { type: "page_id", page_id: p.root },
        title: text("Tasks"),
        initial_data_source: {
          properties: { Name: { title: {} }, Status: { status: {} }, Assignee: { people: {} } }
        }
      });
  p.source = (database.data_sources as Item[])[0]!.id;
  p.schema = yield* p.send(`data_sources/${p.source}`);
  const status = (
    p.schema.properties as Record<string, { status?: { options: { name: string }[] } }>
  ).Status;
  p.statuses = status?.status?.options.map((o) => o.name) ?? [];
  if (!p.statuses.length) return yield* Effect.fail("Tasks needs a native Status property.");
  const people = yield* p.send("users?page_size=100");
  p.people = (people.results as Item[]).filter((user) => user.type === "person");
  const seed = yield* p.send("pages", "POST", {
    parent: { data_source_id: p.source },
    properties: { Name: { title: text("Prototype seed task") } }
  });
  p.task = p.seed = String(seed.id);
  p.page = p.wiki;
  p.draft = markdown;
  p.url = `https://www.notion.so/${p.root.replaceAll("-", "")}`;
});

/** Form fields can choose free-play fixtures. Guided steps own their targets and draft. */
function actionFor(p: Probe, form: Form, step?: Step): Action | string {
  const op = step ? step.op : form.op;
  const task = step ? p.walkTask : p.task;
  switch (op) {
    case "list":
      return { op };
    case "get":
    case "trash":
    case "restore":
      return { op, task };
    case "create":
      return { op, title: (!step && form.title) || "Prototype follow-up" };
    case "update": {
      const status = (!step && form.status) || p.statuses[1] || p.statuses[0]!;
      const assignee = form.assignee ?? p.assignee;
      if (!p.statuses.includes(status)) return "Choose a discovered status.";
      if (assignee && !p.people.some((person) => person.id === assignee))
        return "Choose a discovered person.";
      return { op, task, status, assignee, title: (!step && form.title) || "Prototype reviewed" };
    }
    case "read":
    case "edit": {
      const page = step ? (p.walk === "Access" ? p.access : p.wiki) : form.target || p.page;
      if (!step && ![p.wiki, p.access, p.child].includes(page)) return "Choose a fixture page.";
      if (op === "read") return { op, page };
      const draft = step ? p.walkMarkdown : p.loaded === page ? p.draft : undefined;
      if (draft === undefined) return "Read this page before editing its markdown.";
      return {
        op,
        page,
        markdown:
          (!step ? form.markdown : undefined) ?? draft + "\n\n**Edited through Brightline.**"
      };
    }
    case "child":
      return { op, markdown: form.markdown || markdown };
    default:
      return "Choose a prototype action.";
  }
}

const call = Effect.fn("NotionPrototype.call")(function* (p: Probe, action: Action) {
  let result: Result;
  switch (action.op) {
    case "list":
      result = yield* p.send(`data_sources/${p.source}/query`, "POST", { page_size: 100 });
      break;
    case "get":
      result = yield* p.send(`pages/${action.task}`);
      break;
    case "create":
      result = yield* p.send("pages", "POST", {
        parent: { data_source_id: p.source },
        properties: { Name: { title: text(action.title) } }
      });
      p.task = String(result.id);
      break;
    case "update":
      result = yield* p.send(`pages/${action.task}`, "PATCH", {
        properties: {
          Name: { title: text(action.title) },
          Status: { status: { name: action.status } },
          Assignee: { people: action.assignee ? [{ id: action.assignee }] : [] }
        }
      });
      p.assignee = action.assignee;
      break;
    case "trash":
    case "restore":
      result = yield* p.send(`pages/${action.task}`, "PATCH", { in_trash: action.op === "trash" });
      break;
    case "read":
      result = yield* p.send(`pages/${action.page}/markdown`);
      if (p.loaded !== action.page) p.before = "";
      p.loaded = action.page;
      p.draft = String(result.markdown);
      if (!p.before) p.before = p.draft;
      break;
    case "edit":
      result = yield* p.send(`pages/${action.page}/markdown`, "PATCH", {
        type: "replace_content",
        replace_content: {
          new_str: action.markdown
        }
      });
      break;
    case "child":
      result = yield* p.send("pages", "POST", {
        parent: { page_id: p.root },
        properties: { title: { title: text("Prototype child") } },
        markdown: action.markdown
      });
      p.child = p.page = String(result.id);
      p.loaded = "";
      p.before = "";
      break;
  }
  p.url =
    typeof result.url === "string"
      ? result.url
      : `https://www.notion.so/${p.page.replaceAll("-", "")}`;
  return result;
});

function workspace(p: Probe) {
  const entry = (name: string, label: string, value: string) =>
    field({ id: name, label, control: (aria) => input(aria, { name, value }) });
  const buttons = (ops: [string, string][]) =>
    ops
      .map(([op, label]) => button(label, { name: "op", value: op, pendingLabel: "Working…" }))
      .join(" ");
  const person = (id: string) =>
    field({
      id,
      label: "Assignee",
      control: (aria) =>
        select(aria, {
          name: "assignee",
          choices: [
            { value: "", label: "Unassigned" },
            ...p.people.map((user) => ({ value: user.id, label: user.name || "Unnamed person" }))
          ],
          value: p.assignee
        })
    });
  const step = walks[p.walk]?.[p.step];
  return detailPage({
    title: "Notion prototype",
    parent: { label: "Integrations", href: "/settings/integrations" },
    mark: "N",
    meta: ["Try real Tasks, wiki editing and access removal together."],
    actions:
      linkButton("Connect again", path) +
      `<form method="post" action="${work}">${button("Disconnect", { name: "disconnect", value: "yes" })}</form>`,
    main:
      section({
        title: "Walkthroughs",
        body: `<form method="post" action="${work}">${Object.keys(walks)
          .map((walk) => button(walk, { name: "walk", value: walk }))
          .join(
            " "
          )}</form>${p.walk ? `<p>${escapeHtml(p.walk)} · ${p.step} / ${walks[p.walk]!.length}</p>` : ""}${p.walk === "Wiki" ? `<p>Open Handbook in Notion and use ••• → More → Turn into wiki before continuing. The API cannot do this step.</p>${linkButton("Open Handbook", `https://www.notion.so/${p.wiki.replaceAll("-", "")}`)}` : ""}${step ? `<form method="post" action="${work}">${step.op === "update" ? person("walk-assignee") : ""}${step.op === "pause" ? `<p>Remove Testtoken from Access probe in Notion. Access inherited from its parent must also be removed; the page must be inaccessible to the connection.</p>${linkButton("Open Access probe", `https://www.notion.so/${p.access.replaceAll("-", "")}`)}` : ""}${button(step.op === "pause" ? "I removed access — continue" : step.label, { name: "next", value: "yes", pendingLabel: "Working…" })}</form>` : p.walk ? "<p>Walkthrough complete.</p>" : ""}`
      }) +
      section({
        title: "Tasks",
        body: `<form method="post" action="${work}">${entry("title", "Title", "Prototype reviewed")}${field({ id: "status", label: "Status", control: (aria) => select(aria, { name: "status", choices: p.statuses.map((name) => ({ value: name, label: name })) }) })}${person("assignee")}<div class="cluster">${buttons(
          [
            ["list", "List"],
            ["get", "Open"],
            ["create", "Create"],
            ["update", "Update"],
            ["trash", "Trash"],
            ["restore", "Restore"]
          ]
        )}</div></form>`
      }) +
      section({
        title: "Pages and wiki",
        body: `<form method="post" action="${work}">${field({
          id: "target",
          label: "Page",
          control: (aria) =>
            select(aria, {
              name: "target",
              value: p.page,
              choices: [
                { value: p.wiki, label: "Handbook" },
                { value: p.access, label: "Access probe" },
                ...(p.child ? [{ value: p.child, label: "Prototype child" }] : [])
              ]
            })
        })}${field({ id: "markdown", label: "Markdown", control: (aria) => textarea(aria, { name: "markdown", value: p.draft }) })}<div class="cluster">${buttons(
          [
            ["read", "Read"],
            ["edit", "Edit"],
            ["child", "Create child"]
          ]
        )}</div></form>`
      }),
    aside:
      section({
        title: "Current state",
        body:
          facts([
            ["Database", "Tasks"],
            [
              "Selected page",
              p.page === p.wiki
                ? "Handbook"
                : p.page === p.access
                  ? "Access probe"
                  : "Prototype child"
            ],
            ["Last action", p.history.at(-1) || "Connected"]
          ]) +
          linkButton("Open in Notion", p.url) +
          (p.error
            ? notice({ tone: "danger", title: "Call refused", body: escapeHtml(p.error) })
            : "") +
          `<ol>${p.history.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ol>` +
          pretty({ request: p.request, result: p.last })
      }) +
      section({
        title: "Markdown comparison",
        body:
          disclosure("Before editing", pretty(p.before)) +
          disclosure("Latest read", pretty(p.draft))
      }) +
      section({
        title: "Discovered schema",
        body: disclosure("Tasks properties", pretty(p.schema))
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
    const gate = yield* Semaphore.make(1);
    const serve = (target: "connect" | "workspace", method: "GET" | "POST") =>
      Effect.gen(function* () {
        const viewer = yield* RequireSession.Viewer;
        const session = yield* Session.Session;
        if (viewer.company.handle !== "brightline" || viewer.role !== "admin")
          return HttpServerResponse.empty({ status: 403 });
        const p = probes.get(viewer.company.id);
        if (!p && target === "workspace") return HttpServerResponse.redirect(path, { status: 303 });
        let error = "";
        if (method === "POST" && target === "connect") {
          const form = yield* HttpServerRequest.schemaBodyUrlParams(Form);
          const outcome = yield* Effect.gen(function* () {
            const token = form.key?.trim() ?? "";
            const probe: Probe = {
              handle: form.handle || "probe",
              send: () => Effect.fail("Connect first."),
              root: "",
              source: "",
              seed: "",
              task: "",
              wiki: "",
              access: "",
              child: "",
              page: "",
              schema: {},
              people: [],
              statuses: [],
              assignee: "",
              walk: "",
              step: 0,
              walkTask: "",
              before: "",
              loaded: "",
              draft: "",
              url: "",
              request: null,
              last: null,
              error: "",
              history: []
            };
            probe.send = (route, method = "GET", body = {}) =>
              Effect.gen(function* () {
                probe.request = { method, route, body };
                const base = HttpClientRequest.make(method)(
                  `https://api.notion.com/v1/${route}`
                ).pipe(
                  HttpClientRequest.setHeaders({
                    Authorization: `Bearer ${token}`,
                    "Notion-Version": "2026-03-11"
                  })
                );
                const response = yield* http.execute(
                  method === "GET" ? base : HttpClientRequest.bodyJsonUnsafe(base, body)
                );
                const result = decode(yield* response.json);
                if (response.status < 200 || response.status >= 300)
                  return yield* new Refusal({
                    status: response.status,
                    code: String(result.code ?? "unknown")
                  });
                return result;
              }).pipe(
                Effect.timeout("15 seconds"),
                Effect.mapError((e) =>
                  isRefusal(e)
                    ? e
                    : "Notion did not complete this call. Check the current state before retrying a write."
                )
              );
            const self = yield* probe.send("users/me");
            if ((self.bot as { owner?: { type?: string } })?.owner?.type !== "workspace")
              return yield* Effect.fail("Use an internal connection owned by the workspace.");
            yield* prepare(probe);
            probe.last = { prepared: "Tasks, Handbook and Access probe", root: probe.root };
            probes.set(viewer.company.id, probe);
          }).pipe(Effect.result);
          if (outcome._tag === "Success") return HttpServerResponse.redirect(work, { status: 303 });
          error = refusalMessage(outcome.failure);
        }
        if (method === "POST" && target === "workspace" && p) {
          const form = yield* HttpServerRequest.schemaBodyUrlParams(Form);
          if (form.disconnect === "yes") {
            probes.delete(viewer.company.id);
            return HttpServerResponse.redirect("/settings/integrations", { status: 303 });
          }
          p.error = "";
          p.last = null;
          p.request = null;
          if (form.walk && Object.hasOwn(walks, form.walk)) {
            p.walk = form.walk;
            p.step = 0;
            p.walkTask = p.seed;
            delete p.walkMarkdown;
            p.before = "";
            p.loaded = "";
            p.history = [];
            p.task = p.seed;
            p.page = form.walk === "Access" ? p.access : p.wiki;
            p.url = `https://www.notion.so/${p.page.replaceAll("-", "")}`;
            return HttpServerResponse.redirect(work, { status: 303 });
          }
          const step = form.next ? walks[p.walk]?.[p.step] : undefined;
          if (step?.op === "pause" || step?.op === "wiki-ready") {
            p.step++;
            return HttpServerResponse.redirect(work, { status: 303 });
          }
          const action =
            form.next && !step ? "Choose a walkthrough first." : actionFor(p, form, step);
          if (typeof action === "string") {
            p.error = action;
          } else {
            if ("page" in action) p.page = action.page;
            if ("task" in action) p.task = action.task;
            const result = yield* call(p, action).pipe(Effect.result);
            if (result._tag === "Failure") {
              p.error = refusalMessage(result.failure);
              if (step?.denied && isRefusal(result.failure) && result.failure.status === 404) {
                p.history.push(`${step.label}: confirmed 404`);
                p.step++;
              }
            } else if (step?.denied) {
              p.error =
                "The connection still has access. Remove its inherited page access in Notion before continuing.";
            } else {
              p.last = result.success;
              p.history.push(step?.label ?? action.op);
              if (step) {
                if (action.op === "create") p.walkTask = p.task;
                if (action.op === "read") {
                  p.walkMarkdown ??= p.draft;
                  p.before = p.walkMarkdown;
                }
                p.step++;
              }
            }
          }
          return HttpServerResponse.redirect(work, { status: 303 });
        }
        const content =
          p && target === "workspace"
            ? workspace(p)
            : ConnectFrame.render({
                integration: { key: "notion-prototype", label: "Notion prototype", mark: "N" },
                spec: connect,
                submitted: {},
                back: "/settings/integrations",
                ...(error
                  ? { notice: { message: error, code: "prototype_refused", status: 422 } }
                  : {})
              });
        return pageResponse(
          { title: "Notion prototype", ...content, app: { viewer, section: "integrations" } },
          session
        );
      });
    for (const [route, target] of [
      [path, "connect"],
      [work, "workspace"]
    ] as const) {
      yield* router.add(
        "GET",
        route,
        RequireSession.withViewer(serve(target, "GET")).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))
        )
      );
      yield* router.add(
        "POST",
        route,
        RequireSession.sameOrigin(
          RequireSession.withViewer(gate.withPermits(1)(serve(target, "POST")))
        ).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))))
      );
    }
  })
).pipe(Layer.provide(FetchHttpClient.layer));

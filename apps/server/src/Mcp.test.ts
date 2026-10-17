import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, PublishCreated, type Manifest } from "@patchy/api";
import { MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies } from "@patchy/companies";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { html, publish, send, server } from "./test/server.js";

const base = "https://patchy.example";
const agentName = "Claude Code";

/**
 * A tier 2 patch whose agent area offers one read and one change. `agent.draft` is
 * undescribed and `notes.add` is the page's, so neither is a tool.
 */
const manifest: typeof Manifest.Type = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 2,
  tables: {
    notes: { description: "The team's notes.", columns: { title: { kind: "text" } }, indexes: {} }
  },
  files: {},
  uses: {},
  handlers: {
    "agent.listNotes": {
      kind: "query",
      description: "Lists the titles of the team's notes.",
      args: {},
      result: { kind: "array", element: { kind: "text" } }
    },
    "agent.addNote": {
      kind: "mutation",
      description: "Adds a note and says who added it.",
      args: { title: { kind: "text", description: "The note's title." } },
      result: { kind: "json" }
    },
    "agent.draft": { kind: "query", args: {}, result: { kind: "json" } },
    "notes.add": {
      kind: "mutation",
      description: "Adds a note from the page.",
      args: { title: { kind: "text" } },
      result: { kind: "json" }
    }
  }
};

const bundle = Effect.promise(() =>
  build({
    stdin: {
      contents: `import { query, mutation, createGuest, t } from "patchy/server";
const listNotes = query({
  description: "Lists the titles of the team's notes.",
  args: {}, result: t.array(t.text()),
  handler: async (ctx) => (await ctx.tables.notes.list()).rows.map((note) => note.title)
});
const addNote = mutation({
  description: "Adds a note and says who added it.",
  args: { title: t.text().describe("The note's title.") }, result: t.json(),
  handler: async (ctx, args) => {
    await ctx.tables.notes.insert({ title: args.title });
    return { agent: ctx.agent, email: ctx.viewer.user.email };
  }
});
const draft = query({ args: {}, result: t.json(), handler: async () => "unfinished" });
const add = mutation({
  description: "Adds a note from the page.",
  args: { title: t.text() }, result: t.json(),
  handler: async (ctx, args) => ctx.tables.notes.insert({ title: args.title })
});
export default createGuest({ agent: { listNotes, addNote, draft }, notes: { add } });`,
      resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
      sourcefile: "mcp-fixture.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"]
  })
).pipe(Effect.map((built) => built.outputFiles[0]!.text));

const decodePublished = Schema.decodeUnknownSync(PublishCreated);
const decodeClient = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }));
const decodeInitialize = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({ protocolVersion: Schema.String, instructions: Schema.String })
  })
);
const decodeToolList = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
  })
);
const decodeFound = Schema.decodeUnknownSync(
  Schema.Struct({
    patches: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.NullOr(Schema.String),
        owner: Schema.String,
        address: Schema.String,
        agentTools: Schema.Array(Schema.String)
      })
    )
  })
);
const decodeOpened = Schema.decodeUnknownSync(
  Schema.Struct({ tools: Schema.Array(Schema.Unknown) })
);
// A JSON-RPC error has no `result`, so it fails this decode rather than passing as a refusal.
const decodeToolReply = Schema.decodeUnknownSync(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      isError: Schema.optionalKey(Schema.Literal(true))
    })
  })
);

/** One JSON-RPC message to the MCP door, with the bearer when there is one. */
const rpc = (token: string | undefined, message: Readonly<Record<string, unknown>>) =>
  send(
    HttpClientRequest.post("/mcp").pipe(
      (request) => (token === undefined ? request : HttpClientRequest.bearerToken(request, token)),
      HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message })
    )
  );

/** A `tools/call`, which always answers as a tool result. */
const callTool = Effect.fn("McpTest.callTool")(function* (
  token: string,
  name: string,
  args: Readonly<Record<string, unknown>>
) {
  const response = yield* rpc(token, {
    id: 1,
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.strictEqual(response.status, 200);
  return decodeToolReply(yield* response.json).result;
});

/** The text of a refusal, failing on a result that is not one. */
const refusalText = (result: ReturnType<typeof decodeToolReply>["result"]) => {
  assert.isTrue(result.isError);
  return result.content.map(({ text }) => text).join("\n");
};

/** A builder's tier 2 patch, published with their CLI token. */
const publishNotes = Effect.fn("McpTest.publishNotes")(function* (token: string, title: string) {
  const response = yield* publish(token, { html: html(title), server: yield* bundle, manifest });
  assert.strictEqual(response.status, 201);
  return decodePublished(yield* response.json);
});

/** The dev person's agent, connected through OAuth with agent access on, and their patch. */
const connect = Effect.gen(function* () {
  yield* (yield* Companies.Companies).setAgentsEnabled({
    companyId: DEV_SEED.companyId,
    enabled: true
  });
  const registered = yield* send(
    HttpClientRequest.post("/oauth/register").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        redirect_uris: ["http://127.0.0.1:4567/callback"],
        client_name: agentName
      })
    )
  );
  assert.strictEqual(registered.status, 201);
  const { token } = yield* (yield* MachineTokens.MachineTokens).mint({
    userId: DEV_SEED.userId,
    name: agentName,
    oauthClientId: decodeClient(yield* registered.json).client_id
  });
  return { token, patch: yield* publishNotes(DEV_SEED.token, "Team notes") };
});

class Connected extends Context.Service<Connected, Effect.Success<typeof connect>>()(
  "test/Mcp/Connected"
) {}

const layer = Layer.effect(Connected, connect).pipe(
  Layer.provideMerge(Layer.mergeAll(Companies.layer, MachineTokens.layer)),
  Layer.provideMerge(server({ NODE_ENV: "development" }))
);

it.layer(layer, { excludeTestServices: true, timeout: 60_000 })("Patchy's MCP door", (it) => {
  it.effect("points an unauthenticated client at OAuth and refuses a CLI token", () =>
    Effect.gen(function* () {
      const initialize = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
      const anonymous = yield* rpc(undefined, initialize);
      assert.strictEqual(anonymous.status, 401);
      assert.strictEqual(
        anonymous.headers["www-authenticate"],
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
      );
      assert.strictEqual((yield* rpc(DEV_SEED.token, initialize)).status, 401);
    })
  );

  it.effect("negotiates the protocol version, accepts notifications and lists four tools", () =>
    Effect.gen(function* () {
      const { token } = yield* Connected;
      const initialize = (protocolVersion: string) =>
        Effect.flatMap(
          rpc(token, { id: 1, method: "initialize", params: { protocolVersion } }),
          (response) => response.json
        ).pipe(Effect.map((body) => decodeInitialize(body).result));
      const supported = yield* initialize("2025-06-18");
      assert.strictEqual(supported.protocolVersion, "2025-06-18");
      assert.include(supported.instructions, DEV_SEED.email);
      assert.strictEqual((yield* initialize("1999-01-01")).protocolVersion, "2025-11-25");

      const notified = yield* rpc(token, { method: "notifications/initialized" });
      assert.strictEqual(notified.status, 202);

      const listed = decodeToolList(
        yield* (yield* rpc(token, { id: 2, method: "tools/list" })).json
      );
      assert.deepStrictEqual(
        listed.result.tools.map(({ name }) => name),
        ["find_patches", "open_patch", "read_patch", "change_patch"]
      );
    })
  );

  it.effect("discloses only the described agent tools, with their JSON Schemas", () =>
    Effect.gen(function* () {
      const { token, patch } = yield* Connected;
      // Tools come back in the stored manifest's key order, which JSONB does not keep.
      const found = decodeFound(
        (yield* callTool(token, "find_patches", { search: patch.name })).structuredContent
      );
      assert.deepStrictEqual(
        found.patches.map((entry) => ({ ...entry, agentTools: [...entry.agentTools].sort() })),
        [
          {
            name: patch.name,
            description: null,
            owner: DEV_SEED.userName,
            address: patch.address,
            agentTools: ["addNote", "listNotes"]
          }
        ]
      );

      const opened = yield* callTool(token, "open_patch", { patch: patch.address });
      assert.isUndefined(opened.isError);
      assert.sameDeepMembers(
        [...decodeOpened(opened.structuredContent).tools],
        [
          {
            name: "listNotes",
            kind: "read",
            description: "Lists the titles of the team's notes.",
            args: { type: "object", properties: {}, required: [], additionalProperties: false },
            returns: { type: "array", items: { type: "string" } }
          },
          {
            name: "addNote",
            kind: "change",
            description: "Adds a note and says who added it.",
            args: {
              type: "object",
              properties: { title: { type: "string", description: "The note's title." } },
              required: ["title"],
              additionalProperties: false
            },
            returns: { description: "Any JSON value." }
          }
        ]
      );
    })
  );

  it.effect(
    "runs tools as the person via the agent, and refuses the rest as tool errors",
    () =>
      Effect.gen(function* () {
        const { token, patch } = yield* Connected;
        const changed = yield* callTool(token, "change_patch", {
          patch: patch.name,
          tool: "addNote",
          args: { title: "From the agent" }
        });
        assert.isUndefined(changed.isError);
        assert.deepStrictEqual(changed.structuredContent, {
          result: { agent: { name: agentName }, email: DEV_SEED.email }
        });
        const read = yield* callTool(token, "read_patch", { patch: patch.name, tool: "listNotes" });
        assert.deepStrictEqual(read.structuredContent, { result: ["From the agent"] });

        assert.include(
          refusalText(
            yield* callTool(token, "read_patch", {
              patch: patch.name,
              tool: "addNote",
              args: { title: "Sneaked in" }
            })
          ),
          "call it with change_patch"
        );
        // Neither undescribed agent handlers nor page handlers are tools, and a refusal names only tools.
        for (const tool of ["missing", "draft", "notes.add"]) {
          const text = refusalText(
            yield* callTool(token, "read_patch", { patch: patch.name, tool })
          );
          assert.include(text, `no agent tool called "${tool}"`);
          for (const hidden of ["draft", "notes.add"].filter((name) => name !== tool))
            assert.notInclude(text, hidden);
        }
        const after = yield* callTool(token, "read_patch", {
          patch: patch.name,
          tool: "listNotes"
        });
        assert.deepStrictEqual(after.structuredContent, { result: ["From the agent"] });
      }),
    30_000
  );

  it.effect("never finds a patch in another company", () =>
    Effect.gen(function* () {
      const { token } = yield* Connected;
      const created = yield* (yield* Companies.Companies).create({
        handle: "mcp-elsewhere",
        name: "Elsewhere",
        clerkUserId: "user_mcp_elsewhere",
        email: "mcp-elsewhere@example.com",
        userName: "Elsewhere Admin"
      });
      const cli = yield* (yield* MachineTokens.MachineTokens).mint({
        userId: created.user.id,
        name: "Laptop"
      });
      const theirs = yield* publishNotes(cli.token, "Elsewhere notes");
      for (const ref of [theirs.patchId, theirs.name]) {
        assert.include(
          refusalText(yield* callTool(token, "open_patch", { patch: ref })),
          `No live patch called "${ref}"`
        );
        assert.include(
          refusalText(yield* callTool(token, "read_patch", { patch: ref, tool: "listNotes" })),
          `No live patch called "${ref}"`
        );
      }
    })
  );

  it.effect("names the company's admins while agent access is off, and works once it is on", () =>
    Effect.gen(function* () {
      const { token, patch } = yield* Connected;
      const companies = yield* Companies.Companies;
      const listNotes = { patch: patch.name, tool: "listNotes" };
      yield* companies.setAgentsEnabled({ companyId: DEV_SEED.companyId, enabled: false });
      const off = refusalText(yield* callTool(token, "read_patch", listNotes));
      assert.include(off, `Agent access is off at ${DEV_SEED.companyName}`);
      assert.include(off, `${DEV_SEED.userName} (${DEV_SEED.email})`);

      yield* companies.setAgentsEnabled({ companyId: DEV_SEED.companyId, enabled: true });
      const on = yield* callTool(token, "read_patch", listNotes);
      assert.isUndefined(on.isError);
    })
  );
});

import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as AuthPages from "./AuthPages.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(AgentConnections.layer),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(AuthPages.layer);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
    )
  );
  return HttpServerResponse.toWeb(response);
});
const page = Effect.fn(function* (path: string, cookie: string) {
  const response = yield* send(path, { headers: { cookie } });
  assert.strictEqual(response.status, 200);
  return yield* Effect.promise(() => response.text());
});
const post = (cookie: string): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: base }
});
const cookieFor = (user: { clerkUserId: string; email: string; name: string }) =>
  signedInCookies(signSession({ sub: user.clerkUserId, email: user.email, name: user.name }));

/** A company whose admin is Alex, with Jordan as a member, and agent access as given. */
const company = Effect.fn(function* (label: string, agentAccess: boolean) {
  const companies = yield* Companies.Companies;
  const created = yield* companies.create({
    handle: `machines-${label}`,
    name: `Studio <${label}>`,
    clerkUserId: `user_machines_${label}`,
    email: `alex-${label}@example.com`,
    userName: "Alex <Admin>"
  });
  const email = `jordan-${label}@example.com`;
  const invite = yield* companies.createInvite({
    companyId: created.company.id,
    email,
    invitedBy: created.user.id
  });
  const member = yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_machines_${label}_member`,
    email,
    name: "Jordan Member"
  });
  if (agentAccess)
    yield* companies.setAgentAccess({
      companyId: created.company.id,
      on: true,
      by: created.user.id
    });
  return {
    admin: { ...created.user, cookie: cookieFor(created.user) },
    member: { ...member, cookie: cookieFor(member) }
  };
});

const connect = (userId: string, clientName: string) =>
  AgentConnections.AgentConnections.use((connections) =>
    connections.create({ userId, clientId: CLAUDE_CODE, clientName })
  );

it.layer(services)("Your machines", (it) => {
  it.effect("shows each agent's own steps on its tab, with the address to give it", () =>
    Effect.gen(function* () {
      const { member } = yield* company("tabs", true);
      const address = `${new URL(base).origin}/mcp`;
      const claude = yield* page("/machines", member.cookie);
      assert.include(
        claude,
        `Machines publishing and agents using patches at <strong>Studio &lt;tabs&gt;</strong> as <span class="auth-email">jordan-tabs@example.com</span>.`
      );
      assert.include(claude, '<section class="section" id="connect-an-agent"');
      assert.include(
        claude,
        '<a href="/machines?agent=claude#connect-an-agent" aria-current="page">Claude</a>'
      );
      assert.include(claude, "Settings › Connectors");
      assert.include(claude, `data-copy="${address}"`);
      assert.notInclude(claude, "claude mcp add");
      // The tabs are links: the page adds no inline script, only the shell's copy buttons.
      assert.include(claude, '<script defer src="/assets/copy.js"></script>');
      assert.notMatch(claude, /<script(?![^>]*\bsrc=)/);

      const codex = yield* page("/machines?agent=codex", member.cookie);
      assert.include(
        codex,
        '<a href="/machines?agent=codex#connect-an-agent" aria-current="page">Codex</a>'
      );
      assert.include(codex, `data-copy="codex mcp add patchy --url ${address}"`);
      assert.include(codex, 'data-copy="codex mcp login patchy"');
      assert.notInclude(codex, "Settings › Connectors");

      const claudeCode = yield* page("/machines?agent=claude-code", member.cookie);
      assert.include(claudeCode, `data-copy="claude mcp add --transport http patchy ${address}"`);
      assert.include(claudeCode, "<code>/mcp</code>");
      const another = yield* page("/machines?agent=another", member.cookie);
      assert.include(another, "such as Cursor and Gemini CLI, can’t connect yet");
      const unknown = yield* page("/machines?agent=%3Cscript%3E", member.cookie);
      assert.include(unknown, 'agent=claude#connect-an-agent" aria-current="page"');
      assert.notInclude(unknown, "%3Cscript");
    })
  );

  it.effect("with agent access off, names the admins, and offers an admin the switch", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* company("off", false);
      const asMember = yield* page("/machines", member.cookie);
      assert.include(asMember, "Agent access is off at Studio &lt;off&gt;");
      assert.include(asMember, "At Studio &lt;off&gt; that’s Alex &lt;Admin&gt;.");
      assert.notInclude(asMember, 'class="tabs"');
      assert.notInclude(asMember, "Turn it on at Company");
      const asAdmin = yield* page("/machines", admin.cookie);
      assert.include(asAdmin, "Agent access is off at Studio &lt;off&gt;");
      assert.include(
        asAdmin,
        '<a class="btn" href="/company#agent-access">Turn it on at Company</a>'
      );
      assert.notInclude(asAdmin, "that’s Alex");
      assert.notInclude(asAdmin, 'class="tabs"');
    })
  );

  it.effect(
    "lists a person's own agents, says when a week-unused one ends, and disconnects one",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const sql = yield* SqlClient.SqlClient;
        const { admin, member } = yield* company("agents", true);
        const fresh = yield* connect(member.id, "Claude <Code>");
        const old = yield* connect(member.id, "Claude <Code>");
        yield* sql`
          UPDATE agent_connections SET created_at = clock_timestamp() - interval '12 days',
            last_used_at = clock_timestamp() - interval '8 days'
          WHERE id = ${old.connection.id}`;
        const foreign = yield* connect(admin.id, "Someone else's agent");
        const html = yield* page("/machines", member.cookie);
        assert.include(
          html,
          '<h3 class="section-heading">Claude &lt;Code&gt; <span class="tag">claude.ai</span></h3>'
        );
        assert.include(html, "<dt>Last used</dt><dd>Not yet</dd>");
        assert.include(html, "8 days ago");
        assert.include(html, "connecting it again makes a new connection");
        const [leftover] = [...html.matchAll(/Not used since .*?\.<\/p>/g)].map(([line]) => line);
        assert.match(
          leftover!,
          /^Not used since <time datetime="[^"]+">\d+ \w+ \d{4}<\/time>\. If you reconnected Claude &lt;Code&gt; since, this is the old one; it ends on its own on <time datetime="[^"]+">\d+ \w+ \d{4}<\/time>\.<\/p>$/
        );
        assert.lengthOf([...html.matchAll(/Not used since/g)], 1, "only the week-unused one");
        assert.notInclude(html, "Someone else");
        assert.include(html, `action="/machines/agents/${fresh.connection.id}/disconnect"`);

        const refused = yield* send(
          `/machines/agents/${foreign.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(refused.status, 404);
        const disconnected = yield* send(
          `/machines/agents/${old.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(disconnected.status, 303);
        assert.strictEqual(disconnected.headers.get("location"), "/machines");
        const connections = yield* AgentConnections.AgentConnections;
        assert.isNull(yield* connections.authenticate(old.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(fresh.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
        const after = yield* page("/machines", member.cookie);
        assert.notInclude(after, old.connection.id);
        assert.include(after, fresh.connection.id);
      })
  );

  it.effect("lists only owned live machines and revokes one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const sql = yield* SqlClient.SqlClient;
      const { admin, member } = yield* company("machines", true);
      const tokens = yield* MachineTokens.MachineTokens;
      const first = yield* tokens.mint({ userId: member.id, name: 'Live "<laptop>"' });
      const second = yield* tokens.mint({ userId: member.id, name: "Second machine" });
      const foreign = yield* tokens.mint({ userId: admin.id, name: "Foreign secret name" });
      const revoked = yield* tokens.mint({ userId: member.id, name: "Revoked machine" });
      yield* tokens.revoke(revoked.id);
      const expired = yield* tokens.mint({ userId: member.id, name: "Expired machine" });
      const idle = yield* tokens.mint({ userId: member.id, name: "Idle machine" });
      yield* sql`UPDATE machine_tokens SET expires_at = '1960-01-01' WHERE id = ${expired.id}`;
      yield* sql`UPDATE machine_tokens SET last_used_at = '1960-01-01' WHERE id = ${idle.id}`;
      const html = yield* page("/machines", member.cookie);
      assert.include(html, "Live &quot;&lt;laptop&gt;&quot;");
      assert.include(html, "<dt>Logged in</dt>");
      assert.include(html, "<dt>Last used</dt><dd><time");
      assert.include(html, `datetime="${first.expiresAt}"`);
      assert.include(html, "or after 30 days unused");
      assert.include(html, `action="/machines/${first.id}/revoke"`);
      assert.include(html, 'action="/logout"');
      for (const absent of [
        first.token,
        second.token,
        foreign.token,
        "Foreign secret name",
        "Revoked machine",
        "Expired machine",
        "Idle machine"
      ])
        assert.notInclude(html, absent);
      const refused = yield* send(`/machines/${foreign.id}/revoke`, post(member.cookie));
      const missing = yield* send("/machines/tok_missing/revoke", post(member.cookie));
      assert.strictEqual(refused.status, 404);
      assert.strictEqual(missing.status, 404);
      assert.strictEqual(
        yield* Effect.promise(() => refused.text()),
        yield* Effect.promise(() => missing.text())
      );
      const one = yield* send(`/machines/${first.id}/revoke`, post(member.cookie));
      assert.strictEqual(one.status, 303);
      assert.strictEqual(one.headers.get("location"), "/machines");
      assert.strictEqual(yield* tokens.authenticate(first.token), null);
      assert.strictEqual((yield* tokens.authenticate(second.token))?.machine.id, second.id);
      const repeated = yield* send(`/machines/${first.id}/revoke`, post(member.cookie));
      assert.strictEqual(repeated.status, 303);
    })
  );

  it.effect("Disconnect everything is always there and empties both lists", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const { admin, member } = yield* company("everything", true);
      const tokens = yield* MachineTokens.MachineTokens;
      const connections = yield* AgentConnections.AgentConnections;
      const button =
        '<form class="actions" method="post" action="/machines/revoke-all"><button class="btn btn-danger" type="submit">Disconnect everything</button></form>';
      // Nothing listed yet, and still reachable: an approval not yet collected can be cancelled.
      const bare = yield* page("/machines", member.cookie);
      assert.include(bare, button);
      const machine = yield* tokens.mint({ userId: member.id, name: "Laptop" });
      const agent = yield* connect(member.id, "Claude Code");
      const foreign = yield* connect(admin.id, "Claude Code");
      const listed = yield* page("/machines", member.cookie);
      assert.include(listed, button);
      assert.include(listed, `/machines/${machine.id}/revoke`);
      assert.include(listed, `/machines/agents/${agent.connection.id}/disconnect`);

      const ended = yield* send("/machines/revoke-all", post(member.cookie));
      assert.strictEqual(ended.status, 303);
      assert.isNull(yield* tokens.authenticate(machine.token));
      assert.isNull(yield* connections.authenticate(agent.tokens.accessToken));
      assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
      const empty = yield* page("/machines", member.cookie);
      assert.include(empty, "No agents are connected.");
      assert.include(empty, "No machines are logged in.");
      assert.include(empty, button);
    })
  );
});

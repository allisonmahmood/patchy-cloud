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
import * as Receipt from "./Receipt.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";
import { NodeCryptography } from "@patchy/core";

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
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provide(NodeCryptography.layer)
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
const post = (cookie: string, form?: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: base },
  ...(form === undefined ? {} : { body: new URLSearchParams(form) })
});
/** A page's own content, without the shell's styles and sidebar. */
const mainOf = (html: string) =>
  html.slice(html.indexOf('<main class="app-page">'), html.indexOf("</main>"));
/** The receipt `response` left for `userId`'s next page, if any. */
const receiptFor = (response: Response, userId: string) => {
  const cookies = Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );
  return Receipt.take(cookies, { userId, publicBaseUrl: base }).text;
};
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

it.layer(services)("Your agents", (it) => {
  it.effect(
    "lists what's connected first and opens a section's setup only when empty or asked",
    () =>
      Effect.gen(function* () {
        const { member } = yield* company("first", true);
        const origin = new URL(base).origin;
        const bare = yield* page("/machines", member.cookie);
        assert.include(bare, '<h1 class="page-heading">Your agents</h1>');
        assert.isBelow(bare.indexOf('id="build-heading"'), bare.indexOf('id="use-heading"'));
        assert.include(bare, "<p>No computer publishes as you yet.</p>");
        assert.include(bare, '<details class="agents-add" id="add-a-computer" open>');
        assert.include(bare, `data-copy="Set up Patchy using ${origin}/llms.txt"`);
        assert.include(bare, 'aria-label="Copy the setup line"');
        assert.include(bare, "<p>No app uses patches as you yet.</p>");
        assert.include(bare, '<details class="agents-add" open>');
        for (const cut of ["Lost a laptop?", "Machines publishing and agents", "?s="])
          assert.notInclude(bare, cut);

        const machine = yield* (yield* MachineTokens.MachineTokens).mint({
          userId: member.id,
          name: "Studio Mac mini"
        });
        yield* connect(member.id, "Claude Code");
        const listed = yield* page("/machines", member.cookie);
        assert.include(listed, '<details class="agents-add" id="add-a-computer">');
        assert.include(listed, '<details class="agents-add">');
        // A link to the fragment opens the closed disclosure: it names the body inside it.
        assert.include(listed, '<div class="agents-add-body" id="connect-an-agent">');
        assert.isBelow(
          listed.indexOf(`/machines/${machine.id}/revoke`),
          listed.indexOf('id="add-a-computer"')
        );
        assert.notInclude(listed, "No computer publishes as you yet.");
        // A link from a released CLI or skill opens the steps, whatever it names.
        for (const agent of ["codex", "another", "%3Cscript%3E"])
          assert.include(
            yield* page(`/machines?agent=${agent}`, member.cookie),
            '<details class="agents-add" open>'
          );
      })
  );

  it.effect("shows each agent's own steps on its tab, as instructions, with the address", () =>
    Effect.gen(function* () {
      const { member } = yield* company("tabs", true);
      const address = `${new URL(base).origin}/mcp`;
      const claude = yield* page("/machines", member.cookie);
      assert.include(
        claude,
        '<a href="/machines?agent=claude#connect-an-agent" aria-current="page">Claude</a>'
      );
      assert.include(claude, "Settings › Connectors");
      assert.include(claude, `data-copy="${address}"`);
      assert.include(claude, 'aria-label="Copy Patchy’s address"');
      assert.notInclude(claude, "claude mcp add");
      // Nothing tracks the steps, so none is lit as the current one.
      assert.notInclude(mainOf(claude), "step-current");
      assert.notInclude(mainOf(claude), 'aria-current="step"');
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
      assert.include(codex, 'aria-label="Copy the sign-in command"');
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
      const off =
        '<p class="note note-warn" id="connect-an-agent">Agent access is off at Studio &lt;off&gt;. Alex &lt;Admin&gt; can turn it on.';
      const asMember = yield* page("/machines?agent=codex", member.cookie);
      assert.include(asMember, `${off}</p>`);
      assert.notInclude(asMember, 'class="tabs"');
      assert.notInclude(mainOf(asMember), "/company/agent-access");
      const asAdmin = yield* page("/machines", admin.cookie);
      assert.include(asAdmin, `${off} <a href="/company/agent-access">Turn it on</a></p>`);
      assert.notInclude(asAdmin, 'class="tabs"');
    })
  );

  it.effect(
    "lists a person's own agents, says when a week-unused one ends, and disconnects one by name",
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
        assert.include(html, '<h3 class="section-heading">Claude &lt;Code&gt;</h3>');
        assert.match(html, /claude\.ai · connected <time[^>]+>[^<]+<\/time> · no calls yet/);
        assert.match(html, /· last call <time[^>]+>8 days ago<\/time>/);
        const [leftover] = [...html.matchAll(/If you reconnected .*?\.<\/p>/g)].map(
          ([line]) => line
        );
        assert.match(
          leftover!,
          /^If you reconnected Claude &lt;Code&gt; since, this is the old one; it ends on its own on <time datetime="[^"]+">\d+ \w+ \d{4}<\/time>\.<\/p>$/
        );
        assert.lengthOf([...html.matchAll(/If you reconnected/g)], 1, "only the week-unused one");
        assert.notInclude(html, "Someone else");
        assert.include(html, `action="/machines/agents/${fresh.connection.id}/disconnect"`);
        assert.include(html, 'aria-label="Disconnect Claude &lt;Code&gt;, connected ');

        const refused = yield* send(
          `/machines/agents/${foreign.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(refused.status, 404);
        assert.isUndefined(receiptFor(refused, member.id));
        const disconnected = yield* send(
          `/machines/agents/${old.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(disconnected.status, 303);
        assert.strictEqual(disconnected.headers.get("location"), "/machines");
        assert.strictEqual(receiptFor(disconnected, member.id), "Disconnected Claude <Code>");
        const connections = yield* AgentConnections.AgentConnections;
        assert.isNull(yield* connections.authenticate(old.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(fresh.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
        const after = yield* page("/machines", member.cookie);
        assert.notInclude(after, old.connection.id);
        assert.include(after, fresh.connection.id);
      })
  );

  it.effect("lists only owned live machines and revokes one by name", () =>
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
      assert.include(html, '<h3 class="section-heading">Live &quot;&lt;laptop&gt;&quot;</h3>');
      assert.match(html, /Used <time[^>]+>just now<\/time> · expires <time datetime="[^"]+">/);
      assert.include(html, `datetime="${first.expiresAt}"`);
      assert.include(html, "or after 30 days unused");
      assert.include(html, `action="/machines/${first.id}/revoke"`);
      assert.include(html, 'aria-label="Revoke Live &quot;&lt;laptop&gt;&quot;"');
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
      assert.strictEqual(receiptFor(one, member.id), 'Revoked Live "<laptop>"');
      assert.strictEqual(yield* tokens.authenticate(first.token), null);
      assert.strictEqual((yield* tokens.authenticate(second.token))?.machine.id, second.id);
      const repeated = yield* send(`/machines/${first.id}/revoke`, post(member.cookie));
      assert.strictEqual(repeated.status, 303);
      assert.isUndefined(receiptFor(repeated, member.id), "nothing was listed to name");
    })
  );

  it.effect(
    "Disconnect everything confirms what ends first, only for the account it was shown to",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const { admin, member } = yield* company("everything", true);
        const tokens = yield* MachineTokens.MachineTokens;
        const connections = yield* AgentConnections.AgentConnections;
        const link =
          '<a class="btn btn-quiet btn-danger" href="/machines/revoke-all">Disconnect everything…</a>';
        // Nothing listed yet, and still reachable: an approval not yet collected can be cancelled.
        assert.include(yield* page("/machines", member.cookie), link);
        assert.include(
          yield* page("/machines/revoke-all", member.cookie),
          "No computer or agent is connected, so this ends only approvals not yet collected."
        );
        const machine = yield* tokens.mint({ userId: member.id, name: "Laptop" });
        assert.include(
          yield* page("/machines/revoke-all", member.cookie),
          "This ends 1 computer, and any approval not yet collected."
        );
        const agent = yield* connect(member.id, "Claude Code");
        const foreign = yield* connect(admin.id, "Claude Code");
        const listed = yield* page("/machines", member.cookie);
        assert.include(listed, link);
        assert.notInclude(listed, 'action="/machines/revoke-all"');

        const shown = yield* send("/machines/revoke-all", { headers: { cookie: member.cookie } });
        assert.strictEqual(shown.status, 200);
        assert.strictEqual(shown.headers.get("cache-control"), "private, no-store");
        const confirm = yield* Effect.promise(() => shown.text());
        assert.include(confirm, '<h1 class="page-heading">Disconnect everything?</h1>');
        assert.include(
          confirm,
          "This ends 1 computer and 1 agent, and any approval not yet collected. Each one has to be connected again afterwards."
        );
        assert.include(confirm, `<input type="hidden" name="user" value="${member.id}">`);
        assert.include(confirm, 'action="/machines/revoke-all"');
        // Showing it ends nothing.
        assert.isNotNull(yield* tokens.authenticate(machine.token));
        assert.isNotNull(yield* connections.authenticate(agent.tokens.accessToken));

        // No form, a form without the account, and another account's.
        const refusals: ReadonlyArray<Record<string, string> | undefined> = [
          undefined,
          { other: member.id },
          { user: admin.id }
        ];
        for (const form of refusals) {
          const refused = yield* send("/machines/revoke-all", post(member.cookie, form));
          assert.strictEqual(refused.status, 409);
          assert.include(
            yield* Effect.promise(() => refused.text()),
            'You’re signed in as someone else now. Open <a href="/machines">Your agents</a> and try again.'
          );
          assert.isUndefined(receiptFor(refused, member.id));
          assert.isNotNull(yield* tokens.authenticate(machine.token));
          assert.isNotNull(yield* connections.authenticate(agent.tokens.accessToken));
        }

        const ended = yield* send("/machines/revoke-all", post(member.cookie, { user: member.id }));
        assert.strictEqual(ended.status, 303);
        assert.strictEqual(ended.headers.get("location"), "/machines");
        assert.strictEqual(
          receiptFor(ended, member.id),
          "Disconnected everything: 1 computer and 1 agent"
        );
        assert.isNull(yield* tokens.authenticate(machine.token));
        assert.isNull(yield* connections.authenticate(agent.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
        const empty = yield* page("/machines", member.cookie);
        assert.include(empty, "No computer publishes as you yet.");
        assert.include(empty, "No app uses patches as you yet.");
        assert.include(empty, link);
      })
  );
});

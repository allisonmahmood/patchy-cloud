import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { Companies, InviteMail, Teams, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as AuthPages from "./AuthPages.js";
import * as DeviceLogins from "./DeviceLogins.js";
import { getAnAgent } from "./getAnAgent.js";
import { appNamed } from "./MachinesPage.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Receipt from "./Receipt.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";
import { NodeCryptography, switcherRelay } from "@patchy/core";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  Teams.layer,
  InviteMail.layerRecording
).pipe(
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(AgentConnections.layer),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(NodeCryptography.layer)
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
const page = Effect.fn(function* (path: string, cookie: string, status = 200) {
  const response = yield* send(path, { headers: { cookie } });
  assert.strictEqual(response.status, status, path);
  return yield* Effect.promise(() => response.text());
});
const post = (cookie: string, form?: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: base },
  ...(form === undefined ? {} : { body: new URLSearchParams(form) })
});
/** A page's own content, without the shell's styles and sidebar, or a dialog over it. */
const mainOf = (html: string) =>
  html.slice(html.indexOf('<main class="app-page">'), html.indexOf("</main>"));
/** The dialog drawn over a page, if any. */
const dialogOf = (html: string) => {
  const at = html.indexOf('<section class="dialog');
  return at === -1 ? "" : html.slice(at, html.indexOf("</body>"));
};
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

const disconnectAll =
  '<a class="btn btn-danger btn-sm" href="/agents/disconnect-all">Disconnect everything…</a>';

it("knows an app by any client name that holds its own, the longest name first", () => {
  const names: ReadonlyArray<readonly [string, string]> = [
    ["Claude", "claude"],
    ["Claude Desktop", "claude"],
    ["claude-code", "claude-code"],
    ["Claude Code (patchy)", "claude-code"],
    ["ChatGPT", "chatgpt"],
    ["OpenAI Codex", "codex"],
    ["codex-mcp-client", "codex"],
    ["cursor-vscode", "cursor"],
    ["Zed", "another"],
    ["OpenAI", "another"],
    ["CLAUDE.AI", "claude"],
    ["", "another"]
  ];
  for (const [name, app] of names) assert.strictEqual(appNamed(name), app, name);
});

it.layer(services)("Your agents", (it) => {
  it.effect("leads with what's connected, apps then computers, each way to add one a flow", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* company("first", true);
      const bare = mainOf(yield* page("/agents", member.cookie));
      assert.include(bare, '<h1 class="title">Your agents</h1>');
      assert.include(bare, "Agent access is on at Studio &lt;first&gt;");
      assert.notInclude(bare, "/settings/agent-access", "a member can't change it");
      assert.include(
        mainOf(yield* page("/agents", admin.cookie)),
        '<a href="/settings/agent-access">Change</a>'
      );
      assert.isBelow(bare.indexOf("Use patches"), bare.indexOf("Build patches"));
      assert.include(bare, "No app uses patches as you yet");
      assert.include(bare, "No computer builds as you yet");
      // The links keep the ids that old `/machines#add-a-computer` and `#connect-an-agent` name.
      assert.include(bare, 'id="connect-an-agent" href="/agents/connect"');
      assert.include(bare, 'id="add-a-computer" href="/agents/computer"');
      // Nothing listed, and still reachable: an approval not yet collected can be cancelled.
      assert.include(bare, disconnectAll);
      for (const cut of ["Set up Patchy using", "<details", "Revoke", "<style"])
        assert.notInclude(bare, cut);

      const machine = yield* (yield* MachineTokens.MachineTokens).mint({
        userId: member.id,
        name: "Studio Mac mini"
      });
      const app = yield* connect(member.id, "Claude Code");
      const listed = mainOf(yield* page("/agents", member.cookie));
      assert.notInclude(listed, "No computer builds as you yet");
      assert.notInclude(listed, "No app uses patches as you yet");
      assert.include(listed, '<span class="row-name">Studio Mac mini</span>');
      assert.match(listed, /Used just now · expires \d+ \w+ \d{4} unless used/);
      assert.include(listed, '<span class="row-name">Claude Code</span>');
      assert.match(
        listed,
        /<span class="im im-logo" aria-hidden="true"><svg viewBox="0 0 94 94"[^]*?<span class="row-name">Claude Code</
      );
      assert.match(listed, /claude\.ai · connected \d+ \w+ \d{4} · no calls yet/);
      // Disconnect is in each row's menu, and asks first at the row's own address.
      assert.include(listed, `href="/agents/computers/${machine.id}/disconnect"`);
      assert.include(listed, `href="/agents/apps/${app.connection.id}/disconnect"`);
      assert.include(listed, 'aria-label="Disconnect…, Studio Mac mini"');
      assert.notInclude(listed, "<form", "nothing on the list posts without asking");
      assert.notInclude(listed, "Expires soon");
      assert.notInclude(listed, "Access ended");
    })
  );

  it.effect("connects an app by choosing it, then only that app's steps", () =>
    Effect.gen(function* () {
      const { member } = yield* company("tabs", true);
      const address = `${new URL(base).origin}/mcp`;
      const claude = yield* page("/agents/connect", member.cookie);
      const main = mainOf(claude);
      assert.include(main, '<h1 class="title">Connect an app</h1>');
      assert.include(main, '<a class="ph-parent" href="/agents">');
      assert.include(
        main,
        '<a class="choice-link" href="/agents/connect?app=claude" aria-current="page">'
      );
      for (const app of ["chatgpt", "claude-code", "codex", "cursor"])
        assert.include(main, `<a class="choice-link" href="/agents/connect?app=${app}">`);
      // Each app wears its maker's logo.
      assert.match(
        main,
        /href="\/agents\/connect\?app=codex"><span class="im im-logo" aria-hidden="true"><svg /
      );
      assert.include(
        main,
        '<a class="choice-link choice-link-dashed" href="/agents/connect?app=another">'
      );
      // The steps keep the id an old `/machines?agent=…#connect-an-agent` link names.
      assert.include(main, '<fieldset class="flow-section" id="connect-an-agent">');
      assert.include(main, "In Claude</legend>");
      assert.include(main, `data-copy="${address}"`);
      assert.include(main, 'aria-label="Copy Patchy’s address"');
      assert.include(main, "Once connected");
      assert.include(main, "Claude uses the agent tools in patches you can open, as you");
      assert.notInclude(main, "claude mcp add");
      // Nothing follows the agent here, so no step is marked current or done.
      assert.notInclude(main, "step-current");
      assert.notInclude(main, 'aria-current="step"');
      // Choosing is a link: the page runs no inline script beyond the switcher relay every page
      // carries, only the shell's copy buttons.
      assert.include(claude, '<script defer src="/assets/copy.js"></script>');
      assert.notMatch(claude.replace(switcherRelay, ""), /<script(?![^>]*\bsrc=)/);
      assert.include(claude, '<a class="app-place" href="/agents" aria-current="page">');

      const codex = mainOf(yield* page("/agents/connect?app=codex", member.cookie));
      assert.include(codex, 'href="/agents/connect?app=codex" aria-current="page"');
      assert.include(codex, `data-copy="codex mcp add patchy --url ${address}"`);
      assert.include(codex, 'aria-label="Copy the sign-in command"');
      assert.include(codex, "Your browser opens Patchy to ask whether Codex may act as you.");
      const claudeCode = mainOf(yield* page("/agents/connect?app=claude-code", member.cookie));
      assert.include(claudeCode, `data-copy="claude mcp add --transport http patchy ${address}"`);
      assert.include(claudeCode, "<code>/mcp</code>");
      assert.include(
        mainOf(yield* page("/agents/connect?app=chatgpt", member.cookie)),
        "Only some ChatGPT plans can add custom connectors."
      );
      assert.include(
        mainOf(yield* page("/agents/connect?app=another", member.cookie)),
        "such as Cursor and Gemini CLI, can’t connect yet"
      );
      // Cursor can't connect yet: it says so, with no steps and nothing it could do.
      const cursor = mainOf(yield* page("/agents/connect?app=cursor", member.cookie));
      assert.include(cursor, "Cursor can’t connect yet");
      assert.notInclude(cursor, "Once connected");
      assert.notInclude(cursor, `data-copy="${address}"`);
      // An app it doesn't know, as a released CLI or skill may name, gets Claude's steps.
      const unknown = mainOf(yield* page("/agents/connect?app=%3Cscript%3E", member.cookie));
      assert.include(unknown, 'href="/agents/connect?app=claude" aria-current="page"');
      assert.notInclude(unknown, "%3Cscript");
    })
  );

  it.effect("adds a computer with the setup line, and says where to get an agent", () =>
    Effect.gen(function* () {
      const { member } = yield* company("computer", true);
      const origin = new URL(base).origin;
      const computer = mainOf(yield* page("/agents/computer", member.cookie));
      assert.include(computer, '<h1 class="title">Add a computer</h1>');
      assert.include(computer, '<fieldset class="flow-section" id="add-a-computer">');
      assert.include(computer, `data-copy="Set up Patchy using ${origin}/llms.txt"`);
      assert.include(computer, 'aria-label="Copy the setup line"');
      assert.isBelow(
        computer.indexOf("Give your agent this line"),
        computer.indexOf("Confirm it’s you")
      );
      assert.include(computer, "It can’t do what you can’t");
      assert.include(computer, '<a href="/agents/computer/no-agent">No agent yet?</a>');

      const noAgent = yield* page("/agents/computer/no-agent", member.cookie);
      // The answer is a dialog over the same flow, which closes back to it.
      assert.include(mainOf(noAgent), '<fieldset class="flow-section" id="add-a-computer">');
      const answer = dialogOf(noAgent);
      assert.include(answer, '<h2 id="get-an-agent-title">Get an agent</h2>');
      assert.include(answer, 'data-close="/agents/computer"');
      // The Final step opens the same words in place; each agent links to its maker's own page.
      assert.include(answer, getAnAgent);
      for (const agent of ["Claude Code", "Codex", "Cursor"])
        assert.include(answer, `aria-label="Get ${agent}"`);
      assert.deepStrictEqual(
        [...getAnAgent.matchAll(/<a [^>]*href="([^"]+)" target="_blank" rel="noopener"/g)].map(
          (link) => link[1]
        ),
        [
          "https://claude.com/product/claude-code",
          "https://openai.com/codex/",
          "https://cursor.com/"
        ]
      );
      assert.include(answer, 'href="/agents/computer">Back to setup</a>');
    })
  );

  it.effect("with agent access off, names the admins, and offers an admin the switch", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* company("off", false);
      const asMember = mainOf(yield* page("/agents", member.cookie));
      assert.include(asMember, "Agent access is off at Studio &lt;off&gt;");
      assert.include(asMember, "Alex &lt;Admin&gt; can turn it on");
      assert.include(asMember, '<section class="section" id="connect-an-agent">');
      assert.notInclude(asMember, 'href="/agents/connect"');
      assert.notInclude(asMember, "/settings/agent-access");
      assert.include(
        mainOf(yield* page("/agents", admin.cookie)),
        '<a href="/settings/agent-access">Turn it on</a>'
      );

      const steps = mainOf(yield* page("/agents/connect?app=codex", member.cookie));
      assert.include(steps, '<section class="section" id="connect-an-agent">');
      assert.include(steps, "Agent access is off at Studio &lt;off&gt;");
      assert.include(steps, "<p>Alex &lt;Admin&gt; can turn it on.</p>");
      assert.notInclude(steps, "choice-link");
      assert.notInclude(steps, "codex mcp add");
      assert.notInclude(steps, "/settings/agent-access");
      assert.include(
        mainOf(yield* page("/agents/connect?app=codex", admin.cookie)),
        'href="/settings/agent-access">Turn it on</a>'
      );
    })
  );

  it.effect(
    "lists a person's own apps, says when one is ending or ended, and disconnects one by name",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const sql = yield* SqlClient.SqlClient;
        const { admin, member } = yield* company("agents", true);
        const fresh = yield* connect(member.id, "Claude <Code>");
        const old = yield* connect(member.id, "Claude <Code>");
        yield* sql`
          UPDATE agent_connections SET created_at = clock_timestamp() - interval '30 days',
            last_used_at = clock_timestamp() - interval '25 days'
          WHERE id = ${old.connection.id}`;
        const ended = yield* connect(member.id, "ChatGPT");
        yield* sql`
          UPDATE agent_connections SET created_at = clock_timestamp() - interval '50 days',
            last_used_at = clock_timestamp() - interval '35 days'
          WHERE id = ${ended.connection.id}`;
        const foreign = yield* connect(admin.id, "Someone else's agent");
        const html = mainOf(yield* page("/agents", member.cookie));
        assert.lengthOf(
          [...html.matchAll(/<span class="row-name">Claude &lt;Code&gt;<\/span>/g)],
          2
        );
        assert.match(html, /· last call 25 days ago · expires \d+ \w+ \d{4} unless used/);
        assert.lengthOf([...html.matchAll(/Expires soon/g)], 1, "only the one ending this week");
        // One that ended on its own says so, and Reconnect opens its own app's steps.
        assert.include(html, '<span class="row-name">ChatGPT</span>');
        assert.match(html, /claude\.ai · last call 35 days ago · ended \d+ \w+ \d{4}/);
        assert.include(html, "Access ended");
        assert.include(html, 'href="/agents/connect?app=chatgpt" aria-label="Reconnect, ChatGPT"');
        assert.notInclude(html, `/agents/apps/${ended.connection.id}/disconnect`);
        assert.notInclude(html, "Someone else");

        // Disconnect asks first, naming what stops and the day it connected.
        const asked = yield* page(`/agents/apps/${old.connection.id}/disconnect`, member.cookie);
        assert.include(asked, "<title>Disconnect Claude &lt;Code&gt; – Your agents – ");
        assert.include(mainOf(asked), '<h1 class="title">Your agents</h1>');
        const dialog = dialogOf(asked);
        assert.include(dialog, "Disconnect Claude &lt;Code&gt;?");
        assert.match(dialog, /Claude &lt;Code&gt;, connected \d+ \w+ \d{4}, stops using patches/);
        assert.include(dialog, `action="/agents/apps/${old.connection.id}/disconnect"`);
        assert.include(dialog, 'href="/agents" autofocus>Cancel</a>');
        // Asking ends nothing.
        const connections = yield* AgentConnections.AgentConnections;
        assert.isNotNull(yield* connections.authenticate(old.tokens.accessToken));

        // Another person's, or one that isn't there, answers the same inside the app.
        for (const path of [
          `/agents/apps/${foreign.connection.id}/disconnect`,
          "/agents/apps/agc_missing/disconnect"
        ]) {
          const shown = mainOf(yield* page(path, member.cookie, 404));
          assert.include(shown, "That app isn’t on Your agents");
          assert.include(shown, '<h1 class="title">Your agents</h1>');
        }
        const refused = yield* send(
          `/agents/apps/${foreign.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(refused.status, 404);
        assert.include(
          mainOf(yield* Effect.promise(() => refused.text())),
          "That app isn’t on Your agents"
        );
        assert.isUndefined(receiptFor(refused, member.id));

        const disconnected = yield* send(
          `/agents/apps/${old.connection.id}/disconnect`,
          post(member.cookie)
        );
        assert.strictEqual(disconnected.status, 303);
        assert.strictEqual(disconnected.headers.get("location"), "/agents");
        assert.strictEqual(receiptFor(disconnected, member.id), "Disconnected Claude <Code>");
        assert.isNull(yield* connections.authenticate(old.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(fresh.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
        const after = mainOf(yield* page("/agents", member.cookie));
        assert.notInclude(after, old.connection.id);
        assert.include(after, fresh.connection.id);
      })
  );

  it.effect("lists a person's own computers, ending and ended, and disconnects one by name", () =>
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
      const idle = yield* tokens.mint({ userId: member.id, name: "Idle machine" });
      const long = yield* tokens.mint({ userId: member.id, name: "Long gone machine" });
      yield* sql`UPDATE machine_tokens SET last_used_at = now() - interval '26 days'
        WHERE id = ${second.id}`;
      yield* sql`UPDATE machine_tokens SET last_used_at = now() - interval '40 days'
        WHERE id = ${idle.id}`;
      yield* sql`UPDATE machine_tokens SET last_used_at = '1960-01-01' WHERE id = ${long.id}`;
      const html = mainOf(yield* page("/agents", member.cookie));
      assert.include(html, '<span class="row-name">Live &quot;&lt;laptop&gt;&quot;</span>');
      assert.include(html, 'aria-label="Disconnect…, Live &quot;&lt;laptop&gt;&quot;"');
      assert.match(html, /Used 26 days ago · expires \d+ \w+ \d{4} unless used/);
      assert.lengthOf([...html.matchAll(/Expires soon/g)], 1, "only the one ending this week");
      assert.match(html, /Idle machine<\/span><span class="row-desc">Used 40 days ago · ended /);
      assert.include(html, 'href="/agents/computer" aria-label="Reconnect, Idle machine"');
      for (const absent of [
        first.token,
        second.token,
        foreign.token,
        "Foreign secret name",
        "Revoked machine",
        "Long gone machine"
      ])
        assert.notInclude(html, absent);

      const asked = dialogOf(
        yield* page(`/agents/computers/${first.id}/disconnect`, member.cookie)
      );
      assert.include(asked, "Disconnect Live &quot;&lt;laptop&gt;&quot;?");
      assert.include(
        asked,
        "The agents on Live &quot;&lt;laptop&gt;&quot; stop building and publishing patches as you now."
      );
      assert.include(asked, `action="/agents/computers/${first.id}/disconnect"`);
      assert.include(asked, "Disconnect</button>");
      const refused = yield* send(
        `/agents/computers/${foreign.id}/disconnect`,
        post(member.cookie)
      );
      const missing = yield* send("/agents/computers/tok_missing/disconnect", post(member.cookie));
      assert.strictEqual(refused.status, 404);
      assert.strictEqual(missing.status, 404);
      const refusedPage = yield* Effect.promise(() => refused.text());
      assert.strictEqual(refusedPage, yield* Effect.promise(() => missing.text()));
      assert.include(mainOf(refusedPage), "That computer isn’t on Your agents");
      const one = yield* send(`/agents/computers/${first.id}/disconnect`, post(member.cookie));
      assert.strictEqual(one.status, 303);
      assert.strictEqual(one.headers.get("location"), "/agents");
      assert.strictEqual(receiptFor(one, member.id), 'Disconnected Live "<laptop>"');
      assert.strictEqual(yield* tokens.authenticate(first.token), null);
      assert.strictEqual((yield* tokens.authenticate(second.token))?.machine.id, second.id);
      const repeated = yield* send(`/agents/computers/${first.id}/disconnect`, post(member.cookie));
      assert.strictEqual(repeated.status, 303);
      assert.isUndefined(receiptFor(repeated, member.id), "nothing was listed to name");
    })
  );

  it.effect(
    "Disconnect everything asks with what ends first, only for the account it was shown to",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const { admin, member } = yield* company("everything", true);
        const tokens = yield* MachineTokens.MachineTokens;
        const connections = yield* AgentConnections.AgentConnections;
        assert.include(
          dialogOf(yield* page("/agents/disconnect-all", member.cookie)),
          "No app or computer is connected, so this ends only approvals not yet collected."
        );
        const machine = yield* tokens.mint({ userId: member.id, name: "Laptop" });
        assert.include(
          dialogOf(yield* page("/agents/disconnect-all", member.cookie)),
          "This ends 1 computer, and any approval not yet collected."
        );
        const agent = yield* connect(member.id, "Claude Code");
        const foreign = yield* connect(admin.id, "Claude Code");

        const shown = yield* send("/agents/disconnect-all", { headers: { cookie: member.cookie } });
        assert.strictEqual(shown.status, 200);
        assert.strictEqual(shown.headers.get("cache-control"), "private, no-store");
        const html = yield* Effect.promise(() => shown.text());
        // A dialog over Your agents, which goes inert behind it.
        assert.include(html, '<div class="app" inert>');
        assert.include(mainOf(html), "Claude Code");
        const confirm = dialogOf(html);
        assert.include(confirm, '<h2 id="disconnect-all-title">Disconnect everything?</h2>');
        assert.include(
          confirm,
          "This ends 1 app and 1 computer, and any approval not yet collected. You stay signed in here."
        );
        assert.include(confirm, `<input type="hidden" name="user" value="${member.id}">`);
        assert.include(confirm, 'action="/agents/disconnect-all"');
        assert.include(confirm, 'href="/agents" autofocus>Cancel</a>');
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
          const refused = yield* send("/agents/disconnect-all", post(member.cookie, form));
          assert.strictEqual(refused.status, 409);
          // The dialog is drawn again for the account signed in now, saying nothing ended.
          const html = yield* Effect.promise(() => refused.text());
          assert.include(mainOf(html), "Claude Code");
          const again = dialogOf(html);
          assert.include(again, "Nothing was disconnected");
          assert.include(again, "You’re signed in as someone else now.");
          assert.include(again, "This ends 1 app and 1 computer");
          assert.include(again, `<input type="hidden" name="user" value="${member.id}">`);
          assert.include(again, 'href="/agents" autofocus>Cancel</a>');
          assert.isUndefined(receiptFor(refused, member.id));
          assert.isNotNull(yield* tokens.authenticate(machine.token));
          assert.isNotNull(yield* connections.authenticate(agent.tokens.accessToken));
        }

        const ended = yield* send(
          "/agents/disconnect-all",
          post(member.cookie, { user: member.id })
        );
        assert.strictEqual(ended.status, 303);
        assert.strictEqual(ended.headers.get("location"), "/agents");
        assert.strictEqual(
          receiptFor(ended, member.id),
          "Disconnected everything: 1 app and 1 computer"
        );
        assert.isNull(yield* tokens.authenticate(machine.token));
        assert.isNull(yield* connections.authenticate(agent.tokens.accessToken));
        assert.isNotNull(yield* connections.authenticate(foreign.tokens.accessToken));
        const empty = mainOf(yield* page("/agents", member.cookie));
        assert.include(empty, "No computer builds as you yet");
        assert.include(empty, "No app uses patches as you yet");
        assert.include(empty, disconnectAll);
      })
  );

  it.effect("says inside the app when what it lists can't be read", () =>
    Effect.gen(function* () {
      const { member } = yield* company("offline", true);
      const tokens = yield* MachineTokens.MachineTokens;
      const offline = new SqlError({
        reason: new ConnectionError({ cause: new Error("database offline") })
      });
      const response = yield* send("/agents", { headers: { cookie: member.cookie } }).pipe(
        Effect.provideService(
          MachineTokens.MachineTokens,
          MachineTokens.MachineTokens.of({ ...tokens, list: () => Effect.fail(offline) })
        )
      );
      assert.strictEqual(response.status, 503);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, '<a class="app-place" href="/agents" aria-current="page">');
      assert.include(mainOf(html), "Your agents is unavailable");
    })
  );
});

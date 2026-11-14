import { assert, it } from "@effect/vitest";
import type { Users } from "@patchy/companies";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as GithubDouble from "../test/github.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as ImapTest from "../test/imap.js";
import * as AttioSource from "../attio/Source.js";
import { createCompany, follow, post, read, send, services } from "../test/pages.js";
import * as Page from "./Page.js";

/**
 * GitHub's pages over a scripted GitHub: the connect page in the shared frame before and after
 * signing in, the round trip through GitHub, and the connection's page when the App is suspended.
 */

const world = GithubDouble.world();
const org = world.add({
  id: 4101,
  account: { id: 9101, login: "northwind-labs", type: "Organization" },
  repositories: [
    { id: 11, name: "api" },
    { id: 12, name: "web" },
    { id: 13, name: "docs", private: false }
  ]
});
world.person("mira", {
  id: 7101,
  login: "mira-okafor",
  sees: new Set([4101]),
  admin: new Set([11, 12])
});
world.person("ana", { id: 7102, login: "ana-lind", sees: new Set(), admin: new Set() });
const installUrl = "https://github.com/apps/patchy-cloud-test/installations/new";

/**
 * The submit button a form owns that comes first, which Enter in one of its fields presses: a
 * button joined to another form by its `form` attribute isn't one.
 */
const enterPresses = (html: string, action: string) => {
  const start = html.indexOf(`<form method="post" action="${action}"`);
  const form = html.slice(start, html.indexOf("</form>", start));
  return /<button(?![^>]*\sform=)[^>]*type="submit"[^>]*>.*?<\/button>/s.exec(form)?.[0] ?? "";
};
const connectionId = (response: Response) =>
  new URL(response.headers.get("location")!, "https://patchy.test").pathname.split("/").at(-1)!;

/** Continue with GitHub, then back from GitHub signed in as `login`: where the callback lands. */
const signIn = Effect.fn("test.signIn")(function* (
  user: Users.User,
  login: string,
  start = `${Page.startPath}?purpose=connect`
) {
  const started = yield* send(start, post(user));
  assert.strictEqual(started.status, 303);
  const authorize = new URL(started.headers.get("location")!);
  assert.strictEqual(authorize.origin, "https://github.com");
  assert.strictEqual(authorize.searchParams.get("code_challenge_method"), "S256");
  const { code, state } = world.authorize(login, authorize.toString());
  const back = yield* read(
    `${Page.callbackPath}?${new URLSearchParams({ code, state }).toString()}`,
    user
  );
  return back.response;
});

it.layer(services(PidgeonTest.canned().layer, AttioSource.layer, ImapTest.offline, world.layer))(
  "GitHub connection pages",
  (it) => {
    it.effect("asks to sign in first, with the steps after it locked", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("github-page");
        const page = yield* read(Page.connectPath, owner.user);
        assert.strictEqual(page.status, 200);
        for (const part of [
          '<h1 class="title">Connect GitHub</h1>',
          '<span class="im im-logo im-lg" aria-hidden="true"><svg viewBox="0 0 98 96"',
          '<span class="flow-number">1</span>Sign in to GitHub',
          "Patchy asks GitHub which repositories you administer.",
          `formaction="${Page.startPath}?purpose=connect"`,
          '<fieldset class="flow-section" disabled><legend class="flow-title"><span class="flow-number">2</span>Choose repositories',
          "They appear here once you've signed in.",
          '<fieldset class="flow-section" disabled><legend class="flow-title"><span class="flow-number">3</span>Name it',
          "Every member reads the code, pull requests and CI logs of these repositories through patches that use it",
          "Nothing on GitHub can be changed",
          "No other repository can be reached",
          "CI logs can hold secrets a workflow printed.",
          '<fieldset class="fieldset" disabled><button class="btn btn-primary"'
        ])
          assert.include(page.html, part);
        // Its form's redirect lands on GitHub, which the page's policy names.
        assert.include(
          page.response.headers.get("content-security-policy") ?? "",
          "form-action 'self' https://github.com"
        );
        const catalogue = yield* read("/settings/integrations/connect", owner.user);
        assert.include(catalogue.html, "Code, pull requests and CI runs");
      })
    );

    it.effect("lists what the person administers, then connects what they ticked", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("github-connect");
        const back = yield* signIn(owner.user, "mira");
        assert.strictEqual(back.headers.get("location"), Page.connectPath);
        const page = yield* follow(back, owner.user);
        for (const part of [
          "Signed in as <strong>mira-okafor</strong>.",
          "Use another GitHub account",
          "Repositories you administer where Patchy Cloud is installed. One account per connection.",
          '<legend class="field-label">northwind-labs</legend>',
          'value="4101/11"',
          'value="4101/12"',
          `<a href="${installUrl}">Add repositories on GitHub</a>`
        ])
          assert.include(page.html, part);
        // Read-only for this person, so never offered.
        assert.notInclude(page.html, 'value="4101/13"');
        // Enter in the name field presses the connect form's own submit, never a sign-in, whose
        // buttons post a form of their own after it.
        assert.include(enterPresses(page.html, Page.connectPath), "Test and connect");
        assert.include(page.html, `</form>${Page.signInForm}`);
        assert.notInclude(
          page.html,
          '<fieldset class="fieldset" disabled><button class="btn btn-primary"'
        );
        const connected = yield* send(Page.connectPath, {
          ...post(owner.user),
          body: new URLSearchParams([
            ["handle", "platform"],
            ["description", "The platform team's repositories"],
            ["repository", "4101/11"],
            ["repository", "4101/12"]
          ])
        });
        const shown = yield* follow(connected, owner.user);
        for (const part of ["github/platform", "northwind-labs, an organization", "api, web"])
          assert.include(shown.html, part);

        // Suspended on GitHub: refused and said so, in place of Connected, never paused.
        org.suspended = true;
        const id = connectionId(connected);
        yield* send(`/settings/integrations/${id}/test`, post(owner.user));
        const suspended = yield* read(`/settings/integrations/${id}`, owner.user);
        assert.include(suspended.html, "Suspended on GitHub, last checked");
        assert.include(suspended.html, "northwind-labs suspended Patchy Cloud on GitHub");
        assert.notInclude(suspended.html, ">Paused<");
        const index = yield* read("/settings/integrations", owner.user);
        assert.include(index.html, "Suspended on GitHub, last checked");
        org.suspended = false;
      })
    );

    it.effect("Change repositories finds by name what it doesn't list at once", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("github-add");
        const shown = registry["github.picker.shown"].default;
        const ids = Array.from({ length: shown + 10 }, (_, at) => 5000 + at);
        world.add({
          id: 4102,
          account: { id: 9102, login: "fabrikam", type: "Organization" },
          repositories: ids.map((id, at) => ({ id, name: `tool-${String(at).padStart(2, "0")}` }))
        });
        world.person("lena", {
          id: 7103,
          login: "lena-berg",
          sees: new Set([4102]),
          admin: new Set(ids)
        });
        yield* signIn(owner.user, "lena");
        const id = connectionId(
          yield* send(Page.connectPath, {
            ...post(owner.user),
            body: new URLSearchParams([
              ["handle", "tools"],
              ["description", ""],
              ["repository", "4102/5000"]
            ])
          })
        );
        const access = `/settings/integrations/${id}/access`;
        yield* signIn(owner.user, "lena", `${Page.startPath}?purpose=add&connection=${id}`);
        const dialog = yield* read(access, owner.user);
        assert.include(dialog.html, `Showing ${shown} of ${ids.length - 1}.`);
        assert.notInclude(dialog.html, `value="4102/${ids.at(-1)}"`);
        // Enter in the filter searches; it never starts a sign-in.
        assert.include(enterPresses(dialog.html, access), 'aria-label="Filter repositories"');
        // The filter is a GET of the dialog, which keeps what was ticked and unticked.
        const found = yield* read(
          `${access}?${new URLSearchParams([
            ["q", `tool-${ids.length - 1}`],
            ["repository", "4102/5001"]
          ]).toString()}`,
          owner.user
        );
        assert.include(found.html, `value="4102/${ids.at(-1)}"`);
        assert.include(found.html, 'value="4102/5001" checked');
        assert.notInclude(found.html, 'value="5000" checked');
      })
    );

    it.effect("says when there's nothing to choose, and how to install the App", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("github-nothing");
        const page = yield* follow(yield* signIn(owner.user, "ana"), owner.user);
        for (const part of [
          "Signed in as <strong>ana-lind</strong>.",
          "Patchy Cloud isn't installed on an account where you administer a repository.",
          `href="${installUrl}"`,
          "On an organization you don't own, GitHub sends its owners a request.",
          '<fieldset class="fieldset" disabled><button class="btn btn-primary"'
        ])
          assert.include(page.html, part);
      })
    );

    it.effect("the setup return, which may carry no state, goes through GitHub again or home", () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("github-setup");
        const home = yield* read(Page.setupPath, owner.user);
        assert.strictEqual(home.response.headers.get("location"), "/settings/integrations");
        yield* send(`${Page.startPath}?purpose=connect`, post(owner.user));
        const again = yield* read(
          `${Page.setupPath}?installation_id=4101&setup_action=update`,
          owner.user
        );
        const authorize = new URL(again.response.headers.get("location")!);
        assert.strictEqual(authorize.pathname, "/login/oauth/authorize");
        assert.isNotNull(authorize.searchParams.get("state"));
      })
    );
  }
);

it.layer(services(PidgeonTest.canned().layer))("GitHub pages without an App", (it) => {
  it.effect("offers nothing about GitHub", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("github-unoffered");
      const catalogue = yield* read("/settings/integrations/connect", owner.user);
      assert.notInclude(catalogue.html, "GitHub");
      assert.strictEqual((yield* read(Page.connectPath, owner.user)).status, 404);
    })
  );
});

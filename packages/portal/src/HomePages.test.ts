import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { DeviceLogins, SetupLinks } from "@patchy/auth";
import { PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { sha256 } from "../../../test/crypto.js";
import { GuestGrants, Patches } from "@patchy/patches";
import {
  DAY,
  events,
  socket,
  type Person,
  company,
  actor,
  manifest,
  publish,
  request,
  post,
  text,
  heading,
  links,
  cardPath,
  menuItems,
  invoke,
  seedOf,
  publishTier2
} from "./test/fixtures.js";

/** The setup line a page shows, as its copy line's text. */
const lineOf = (html: string) =>
  text(html.match(/<code aria-label="Setup line, select to copy">([^<]*)<\/code>/)?.[1] ?? "");
/** The guide's steps as `[state, title]`, in order. */
const steps = (html: string) =>
  [
    ...html.matchAll(
      /<li class="step(?: step-(done|current))?"[^>]*>[\s\S]*?<p class="step-title">([\s\S]*?)<\/p>/g
    )
  ].map((match) => [match[1] ?? "later", text(match[2]!)]);
/** One of Home's sections by its id: attention, usual, new, yours, colleagues, shared, patches. */
const sectionOf = (html: string, id: string) =>
  html.match(new RegExp(`<section class="section" id="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0] ??
  "";
/** The patch names a section's tiles or rows open, in order. */
const names = (html: string, id: string) =>
  [
    ...sectionOf(html, id).matchAll(
      /<a class="(?:usual-tile|row-link)" href="\/[^/"]+\/([a-z0-9-]+)"/g
    )
  ].map((match) => match[1]!);
/** The names a section's rows mark new to the viewer. */
const unseen = (html: string, id: string) =>
  [
    ...sectionOf(html, id).matchAll(
      /<a class="row-link" href="\/[^/"]+\/([a-z0-9-]+)">[^<]*<\/a> <span class="unseen"/g
    )
  ].map((match) => match[1]!);
/** Whether the Final step is over the page. */
const finalStep = (html: string) => html.includes('id="final-step"');
const connectLine = "Connect your agent to build patches";

it.layer(socket)("Home and the guide on a socket", (it) => {
  it.effect("lays the Final step over Home until the person connects their agent", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const fresh = yield* request("/", workspace.owner);
      assert.strictEqual(fresh.status, 200);
      const html = yield* fresh.text;
      // Home is still Home, inert behind the dialog, which nothing closes but Later.
      assert.strictEqual(heading(html), "Home");
      assert.include(text(html), "No patches yet");
      assert.include(html, '<div class="app" inert>');
      assert.include(
        html,
        '<section class="dialog dialog-md" id="final-step" role="dialog" aria-modal="true" aria-labelledby="final-step-title" data-dialog>'
      );
      assert.include(html, '<h2 id="final-step-title">Final step</h2>');
      assert.deepStrictEqual(steps(html), [
        ["current", "Give your agent this line"],
        ["later", "Confirm it’s you"]
      ]);
      // The line carries the person's setup link, kept across reloads.
      const setup = lineOf(html);
      assert.match(
        setup,
        new RegExp(`^Set up Patchy using ${PUBLIC_BASE_URL}/llms\\.txt\\?s=[a-z2-7]{26}$`)
      );
      assert.include(html, `data-copy="${setup}"`);
      assert.strictEqual(lineOf(yield* (yield* request("/", workspace.owner)).text), setup);
      assert.include(html, '<script defer src="/assets/guide.js"></script>');
      assert.include(html, '<form method="post" action="/guide/later" data-guide-unsettled>');
      // A phone says it happens on a computer, sends the address there, and words Later its way.
      assert.include(text(html), "Look around Northwind first");
      assert.include(
        html,
        `<div data-guide-send hidden><div class="btn-group"><button class="btn btn-primary" type="button" data-share="${PUBLIC_BASE_URL}">Send this to my computer</button></div></div>`
      );
      // The dialog is the way to connect, so Home doesn't offer it again behind.
      assert.notInclude(text(html), connectLine);

      // Later is for this sign-in only, and only from this account's page.
      const cross = yield* request("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(cross.status, 403);
      const stale = yield* post("/guide/later", workspace.owner, { user: workspace.member.id });
      assert.strictEqual(stale.status, 409);
      assert.isTrue(finalStep(yield* (yield* request("/", workspace.owner)).text));
      const later = yield* post("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.strictEqual(later.status, 303);
      assert.strictEqual(later.headers.location, "/");
      // After Later, one line on Home leads to the same steps as a page.
      const after = yield* (yield* request("/", workspace.owner)).text;
      assert.isFalse(finalStep(after));
      assert.include(text(after), connectLine);
      assert.isTrue(links(after).some((link) => link.href === "/guide" && link.text === "Connect"));
      const next = yield* (yield* request("/", workspace.owner, undefined, { sid: "sess_2" })).text;
      assert.isTrue(finalStep(next));

      // Someone with a live machine token sees Home alone, without the way to connect.
      const member = yield* (yield* request("/", workspace.member)).text;
      assert.isFalse(finalStep(member));
      assert.notInclude(member, '<div class="app" inert>');
      assert.notInclude(text(member), connectLine);
    })
  );

  it.effect(
    "shows the Final step for the first week or the first three sign-ins, whichever is longer",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE machine_tokens SET revoked_at = now()
        WHERE user_id IN (${workspace.owner.id}, ${workspace.member.id})`;
        yield* sql`UPDATE users SET created_at = now() - interval '8 days'
        WHERE id IN (${workspace.owner.id}, ${workspace.member.id})`;
        const shown = (person: Person, sid: string) =>
          request("/", person, undefined, { sid }).pipe(
            Effect.flatMap((response) => response.text),
            Effect.map(finalStep)
          );
        assert.deepStrictEqual(
          [
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s2"),
            yield* shown(workspace.owner, "s3"),
            yield* shown(workspace.owner, "s4"),
            yield* shown(workspace.owner, "s1"),
            yield* shown(workspace.owner, "s5")
          ],
          [true, true, true, false, true, false]
        );
        // Past the window Home still offers Connect.
        assert.include(
          text(yield* (yield* request("/", workspace.owner, undefined, { sid: "s5" })).text),
          connectLine
        );
        // Inside the first week every sign-in shows it, a fifth included, and Later sticks for the
        // sign-in that pressed it alone.
        yield* sql`UPDATE users SET created_at = now() WHERE id = ${workspace.owner.id}`;
        assert.isTrue(yield* shown(workspace.owner, "s6"));
        const later = yield* request(
          "/guide/later",
          workspace.owner,
          { user: workspace.owner.id },
          { origin: PUBLIC_BASE_URL, sid: "s6" }
        );
        assert.strictEqual(later.status, 303);
        assert.isFalse(yield* shown(workspace.owner, "s6"));
        assert.isTrue(yield* shown(workspace.owner, "s7"));
        // A connected person's sign-ins count too, so revoking every key later never reopens it.
        yield* sql`UPDATE machine_tokens SET revoked_at = NULL WHERE user_id = ${workspace.member.id}`;
        for (const sid of ["m1", "m2", "m3", "m4"]) yield* shown(workspace.member, sid);
        yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.member.id}`;
        assert.isFalse(yield* shown(workspace.member, "m5"));
      })
  );

  it.effect("counts two new sign-ins arriving at once as two, not both third", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      yield* sql`UPDATE users SET created_at = now() - interval '8 days' WHERE id = ${workspace.owner.id}`;
      const shown = (sid: string) =>
        request("/", workspace.owner, undefined, { sid }).pipe(
          Effect.flatMap((response) => response.text),
          Effect.map(finalStep)
        );
      yield* shown("c1");
      yield* shown("c2");
      const both = yield* Effect.all([shown("c3"), shown("c4")], { concurrency: 2 });
      assert.sameMembers(both, [true, false]);
    })
  );

  it.effect("opens New patch over Home, with a starter line once connected, else the steps", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      const connected = yield* request("/?new", workspace.member);
      assert.strictEqual(connected.status, 200);
      const html = yield* connected.text;
      assert.strictEqual(heading(html), "Home");
      assert.include(html, "<title>New patch – Home – Northwind</title>");
      assert.include(html, '<div class="app" inert>');
      assert.include(html, 'id="new-patch" role="dialog"');
      // Close and Escape lead back to Home.
      assert.include(html, 'data-dialog data-close="/"');
      assert.include(html, 'data-copy="Use Patchy to build Northwind a tool that …"');
      assert.include(text(html), "Your agent is set up on Portal test machine");
      assert.isTrue(links(html).some((link) => link.href === "/agents/computer"));
      assert.deepStrictEqual(steps(html), []);

      // Not yet connected, it holds the Final step's steps and line, and stands in for the Final
      // step, with Home's Connect behind it.
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const setup = yield* (yield* request("/?new", workspace.owner)).text;
      assert.include(setup, 'id="new-patch" role="dialog"');
      assert.isFalse(finalStep(setup));
      assert.deepStrictEqual(steps(setup), [
        ["current", "Give your agent this line"],
        ["later", "Confirm it’s you"]
      ]);
      assert.strictEqual(lineOf(setup), lineOf(yield* (yield* request("/", workspace.owner)).text));
      assert.include(text(setup), connectLine);
      assert.include(setup, '<script defer src="/assets/guide.js"></script>');
      // After Later, Home watches for the first publication, but not while the steps are up and
      // follow the agent themselves.
      yield* post("/guide/later", workspace.owner, { user: workspace.owner.id });
      assert.include(yield* (yield* request("/", workspace.owner)).text, 'data-mode="watch"');
      const regions = (yield* (yield* request("/?new", workspace.owner)).text).match(
        /data-guide-steps/g
      );
      assert.lengthOf(regions ?? [], 1);
    })
  );

  it.effect("follows a person's setup on /guide and /guide/steps from Patchy's records", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const page = yield* (yield* request("/guide", workspace.owner)).text;
      assert.strictEqual(heading(page), "Final step");
      assert.isTrue(links(page).some((link) => link.href === "/" && link.text === "Home"));
      assert.isFalse(finalStep(page));
      assert.notInclude(page, "/guide/later");
      const state = (html: string) => html.match(/data-state="([a-z]+)"/)?.[1];
      assert.strictEqual(
        state(yield* (yield* request("/guide/steps", workspace.owner)).text),
        "waiting"
      );

      // Connected: /guide sends them Home, and the steps say they're set. The key was made just
      // before the test clock's now, so what the member publishes next counts as since then.
      yield* sql`UPDATE machine_tokens SET created_at = to_timestamp(${1_767_225_600 - 3600})
        WHERE user_id = ${workspace.member.id}`;
      const guide = yield* request("/guide", workspace.member);
      assert.strictEqual(guide.status, 303);
      assert.strictEqual(guide.headers.location, "/");
      const connected = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(connected), "connected");
      assert.include(text(connected), "You’re set");
      assert.deepStrictEqual(steps(connected), [
        ["done", "Give your agent this line"],
        ["done", "Confirm it’s you"]
      ]);

      // The first publication after connecting is the live note, a welcome page by its name.
      yield* publish(workspace.member, "welcome");
      const live = yield* (yield* request("/guide/steps", workspace.member)).text;
      assert.strictEqual(state(live), "live");
      assert.include(text(live), "Your welcome page is live");
      const watch = yield* (yield* request("/guide/steps?mode=watch", workspace.member)).text;
      assert.strictEqual(state(watch), "live");
      assert.notInclude(watch, 'class="steps"');
      // Home's watch puts in Home's one-line notice, not the steps'.
      assert.include(watch, 'class="notice notice-info"');
      assert.include(text(watch), "Your welcome page is live");
      assert.notInclude(text(watch), "To change it");
    })
  );

  it.effect("follows the setup line's link through the agent's fetch, login and key", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.owner.id}`;
      const value = lineOf(yield* (yield* request("/", workspace.owner)).text).split("?s=")[1]!;
      assert.lengthOf(
        events.filter(
          (event) => event.name === "setup.line_shown" && event.principalId === workspace.owner.id
        ),
        1
      );
      const state = Effect.gen(function* () {
        const html = yield* (yield* request("/guide/steps", workspace.owner)).text;
        return [html.match(/data-state="([a-z_-]+)"/)?.[1], text(html)] as const;
      });
      assert.strictEqual((yield* state)[0], "waiting");
      yield* SetupLinks.pickUp(value);
      const [picked, pickedText] = yield* state;
      assert.strictEqual(picked, "picked_up");
      assert.include(pickedText, "Your agent opened the line");
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: value });
      const [pending, pendingText] = yield* state;
      assert.strictEqual(pending, "login_pending");
      // The login's own confirmation, right in the steps, still asking for the code check.
      assert.include(pendingText, "A computer wants to publish as you");
      assert.include(pendingText, `Does your agent show ${login.userCode} ?`);
      const fragment = yield* request("/guide/steps", workspace.owner);
      // The fragment carries a confirmation, so nothing may frame it, and the script reloads
      // rather than swap in a fragment for whichever account signed in since.
      assert.include(fragment.headers["content-security-policy"] ?? "", "frame-ancestors 'none'");
      const form = yield* fragment.text;
      assert.include(form, `data-viewer="${workspace.owner.id}"`);
      assert.include(form, `<input type="hidden" name="setup" value="${value}">`);
      // Not me answers even when the name was cleared.
      assert.include(
        form,
        '<button class="btn" type="submit" name="action" value="deny" formnovalidate>Not me</button>'
      );
      yield* logins.confirm({
        userCode: login.userCode,
        userId: workspace.owner.id,
        machineName: "Laptop"
      });
      assert.strictEqual((yield* state)[0], "confirming");
      yield* logins.poll(login.deviceCode);
      assert.strictEqual((yield* state)[0], "connected");

      // A second login with a fresh line contests it; Get a new line starts over.
      yield* sql`UPDATE machine_tokens SET revoked_at = now() WHERE user_id = ${workspace.admin.id}`;
      const first = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      const link = first.split("?s=")[1]!;
      yield* logins.start({ machineNameHint: "laptop", setupLink: link });
      yield* logins.start({ machineNameHint: "elsewhere", setupLink: link });
      const contested = yield* (yield* request("/guide/steps", workspace.admin)).text;
      assert.include(contested, 'data-state="fallback-contested"');
      assert.include(text(contested), "Two computers used this line");
      assert.strictEqual(
        (yield* request("/guide/new-line", workspace.admin, { user: workspace.admin.id })).status,
        403
      );
      assert.strictEqual(
        (yield* post("/guide/new-line", workspace.admin, { user: workspace.owner.id })).status,
        409
      );
      const renewed = yield* post("/guide/new-line", workspace.admin, { user: workspace.admin.id });
      assert.strictEqual(renewed.status, 303);
      assert.strictEqual(renewed.headers.location, "/guide");
      const next = lineOf(yield* (yield* request("/guide", workspace.admin)).text);
      assert.notStrictEqual(next, first);
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="waiting"'
      );

      // A login left unanswered shows as expired once it runs out, with no poll or start after.
      yield* logins.start({ machineNameHint: "laptop", setupLink: next.split("?s=")[1]! });
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="login_pending"'
      );
      yield* TestClock.adjust("11 minutes");
      assert.include(
        yield* (yield* request("/guide/steps", workspace.admin)).text,
        'data-state="fallback-expired"'
      );
    }).pipe(Effect.provide(DeviceLogins.layer))
  );

  it.effect("names the first patch on Home for a day, in one line", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      yield* publish(workspace.admin, "crm");
      const mine = yield* publish(workspace.member, "lead-tracker", { title: "Lead <tracker>" });
      const shipped = yield* (yield* request("/", workspace.member)).text;
      assert.include(shipped, "Lead &lt;tracker&gt; is live");
      assert.notInclude(text(shipped), "Your first patch is live");
      assert.isTrue(
        links(shipped).some(
          (link) => link.href === `/${workspace.handle}/lead-tracker` && link.text === "Open"
        )
      );
      assert.include(shipped, 'aria-label="Copy link to Lead &lt;tracker&gt;"');
      assert.notInclude(
        text(yield* (yield* request(cardPath(mine.name), workspace.member)).text),
        "is live"
      );
      yield* TestClock.adjust(DAY);
      assert.notInclude(text(yield* (yield* request("/", workspace.member)).text), "is live");
    })
  );

  it.effect("tells an owner whose only patches are off that nothing is live", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patch = yield* publish(workspace.owner, "shelved-tool");
      yield* (yield* Patches.Patches).retire(patch.patchId, actor(workspace.owner));
      for (const person of [workspace.owner, workspace.member]) {
        const html = yield* (yield* request("/", person)).text;
        assert.strictEqual(heading(html), "Home");
        assert.include(text(sectionOf(html, "patches")), "Nothing is live");
        assert.isTrue(links(html).some((link) => link.href === "/patches?show=off"));
        assert.deepStrictEqual(names(html, "yours"), []);
      }
      // A company with nothing at all says so, and offers its admins the people to build for.
      const empty = yield* company();
      const admin = yield* (yield* request("/", empty.admin)).text;
      assert.include(text(sectionOf(admin, "patches")), "No patches yet");
      const invite = (html: string) =>
        links(sectionOf(html, "patches")).some(
          (link) => link.href === "/settings/people" && link.text === "Invite people"
        );
      assert.isTrue(invite(admin));
      assert.isFalse(invite(yield* (yield* request("/", empty.member)).text));
    })
  );

  it.effect("fills Your usual from the viewer's own opens of the last 30 days alone", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const [alpha, bravo, charlie, delta, echo] = yield* Effect.forEach(
        ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"],
        (name) => publish(workspace.admin, name)
      );
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(echo!.patchId);
      yield* patches.recordVisit(delta!.patchId);
      const open = (person: Person, patch: Patches.Recorded, times = 1) =>
        Effect.forEach(Array.from({ length: times }), () =>
          patches.recordOpen(person.id, patch.patchId, patch.versionId)
        );

      // No opens: the company's most visited, by title after visits, each saying what and whose.
      const popular = yield* (yield* request("/", workspace.member)).text;
      assert.include(text(popular), "Popular at Northwind");
      assert.deepStrictEqual(names(popular, "usual"), ["echo", "delta", "alpha", "bravo"]);
      assert.include(text(sectionOf(popular, "usual")), "echo Page · Sam");

      // Opened 31 days ago, it has left; once they open anything, the company's picks give way.
      yield* open(workspace.member, charlie!, 5);
      yield* TestClock.adjust(31 * DAY);
      yield* open(workspace.member, bravo!);
      // Another member's opens never move this one's.
      yield* open(workspace.owner, alpha!, 9);
      const usual = yield* (yield* request("/", workspace.member)).text;
      assert.include(text(usual), "Your usual");
      assert.deepStrictEqual(names(usual, "usual"), ["bravo"]);
      assert.notInclude(text(usual), "Popular at Northwind");

      // A rename keeps the opens; retiring takes the patch off Home.
      yield* publish(workspace.admin, "bravo-two", { intent: "update", patchId: bravo!.patchId });
      yield* patches.retire(echo!.patchId, actor(workspace.admin));
      const after = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(names(after, "usual"), ["bravo-two"]);
      assert.notInclude(names(after, "colleagues"), "echo");

      // Below eight live patches Home reads whole, without Your usual or New.
      yield* patches.retire(delta!.patchId, actor(workspace.admin));
      const short = yield* (yield* request("/", workspace.member)).text;
      assert.strictEqual(sectionOf(short, "usual"), "");
      assert.strictEqual(sectionOf(short, "new"), "");
      assert.lengthOf(names(short, "colleagues"), 7);
    })
  );

  it.effect(
    "lists the viewer's own patches A–Z with who can open them, their calls and Share",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const guests = yield* company();
        const quiet = yield* publishTier2(workspace.owner, "quiet-tool");
        const busy = yield* publishTier2(workspace.owner, "busy-tool");
        yield* publish(workspace.owner, "about-us", { scope: "public" });
        const shared = yield* publish(workspace.owner, "site-notes");
        yield* publishTier2(workspace.member, "their-tool");
        yield* (yield* GuestGrants.GuestGrants).share({
          patchId: shared.patchId,
          actor: actor(workspace.owner),
          email: guests.member.email
        });
        yield* invoke(seedOf(workspace.id, busy), workspace.member, {
          handler: "visits.load",
          kind: "query"
        });

        const html = yield* (yield* request("/", workspace.owner)).text;
        const yours = sectionOf(html, "yours");
        assert.deepStrictEqual(names(html, "yours"), [
          "about-us",
          "busy-tool",
          "quiet-tool",
          "site-notes"
        ]);
        assert.include(
          text(yours),
          "Patch Access Failures (24 h) Actions about-us Find the right person Public —"
        );
        assert.include(text(yours), "busy-tool Find the right person Company None");
        assert.include(text(yours), "quiet-tool Find the right person Company No calls yet");
        assert.include(text(yours), "site-notes Find the right person Company + 1 guest —");
        // Share on every row, over Home; the menu has it too.
        for (const name of ["about-us", "busy-tool", "quiet-tool", "site-notes"])
          assert.isTrue(
            links(yours).some((link) => link.href === `/?share=${name}` && link.text === "Share"),
            name
          );
        assert.include(menuItems(html, `yours-${quiet.patchId}`), "Share…");
        // A colleague's patch is theirs, with its owner, never under Yours.
        assert.deepStrictEqual(names(html, "colleagues"), ["their-tool"]);
        assert.include(text(sectionOf(html, "colleagues")), "Owner Updated");
        // Someone who owns nothing has no Yours.
        assert.strictEqual(
          sectionOf(yield* (yield* request("/", workspace.admin)).text, "yours"),
          ""
        );
      })
  );

  it.effect("never says guests can open a patch that turns them away", () =>
    Effect.gen(function* () {
      const guest = yield* company();
      const workspace = yield* company("cmp_portal_guests");
      const payroll = yield* publish(workspace.owner, "payroll-review", {
        filename: null,
        manifest: {
          ...manifest,
          name: "payroll-review",
          tier: 2,
          handlers: {},
          uses: {
            payroll: { kind: "postgres", handle: "payroll", id: "con_payroll", revision: 1 }
          }
        },
        server: {
          objectKey: "patches/payroll-review/server.js",
          sha256: sha256("payroll"),
          bytes: 0
        }
      });
      yield* (yield* GuestGrants.GuestGrants).grant({
        patchId: payroll.patchId,
        userId: guest.member.id,
        grantedBy: workspace.owner.id
      });
      const yours = text(sectionOf(yield* (yield* request("/", workspace.owner)).text, "yours"));
      assert.include(yours, "Company · 1 guest can’t open it");
      assert.notInclude(yours, "Company + 1 guest");
    })
  );

  it.effect("lists colleagues' patches A–Z, twelve of them, with the rest on All patches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const letters = "nmlkjihgfedcba".split("");
      for (const letter of letters) yield* publish(workspace.admin, `${letter}-patch`);
      const html = yield* (yield* request("/", workspace.member)).text;
      assert.deepStrictEqual(
        names(html, "colleagues"),
        [...letters]
          .reverse()
          .slice(0, 12)
          .map((letter) => `${letter}-patch`)
      );
      assert.isTrue(
        links(sectionOf(html, "colleagues")).some(
          (link) => link.href === "/patches" && link.text === "See all 14"
        )
      );
    })
  );

  it.effect(
    "marks a colleague's patch new until the viewer opens it, and lists the newest under New",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const patches = yield* Patches.Patches;
        for (const name of ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"])
          yield* publish(workspace.admin, name);
        yield* TestClock.adjust(8 * DAY);
        const recap = yield* publish(workspace.admin, "weekly-recap");
        yield* TestClock.adjust(60_000);
        yield* publish(workspace.admin, "forms");
        yield* TestClock.adjust(60_000);
        // A public page's opens aren't recorded, so it is never new; nor is the viewer's own.
        yield* publish(workspace.admin, "press-kit", { scope: "public" });
        yield* publish(workspace.member, "my-notes");
        const html = yield* (yield* request("/", workspace.member)).text;
        assert.deepStrictEqual(names(html, "new"), ["forms", "weekly-recap"]);
        assert.include(text(sectionOf(html, "new")), "forms Page · Sam · 1 minute ago");
        assert.deepStrictEqual(unseen(html, "colleagues"), ["forms", "weekly-recap"]);

        // Opening it clears it.
        yield* patches.recordOpen(workspace.member.id, recap.patchId, recap.versionId);
        const opened = yield* (yield* request("/", workspace.member)).text;
        assert.deepStrictEqual(names(opened, "new"), ["forms"]);
        assert.deepStrictEqual(unseen(opened, "colleagues"), ["forms"]);
      })
  );

  it.effect("lists what other companies shared with the viewer, and who, on an empty company", () =>
    Effect.gen(function* () {
      const guests = yield* company();
      const workspace = yield* company();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE companies SET name = 'Harbor Works' WHERE id = ${workspace.id}`;
      const patch = yield* publish(workspace.owner, "site-notes", { title: "Site notes" });
      yield* (yield* GuestGrants.GuestGrants).share({
        patchId: patch.patchId,
        actor: actor(workspace.owner),
        email: guests.member.email
      });
      const html = yield* (yield* request("/", guests.member)).text;
      assert.include(text(sectionOf(html, "patches")), "No patches yet");
      assert.include(html, '<section class="section" id="shared" aria-labelledby="shared-title">');
      assert.include(
        text(sectionOf(html, "shared")),
        "Shared with you Site notes Harbor Works · shared by Priya"
      );
      assert.deepStrictEqual(names(html, "shared"), ["site-notes"]);
    })
  );

  it.effect("sends a search to All patches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const found = yield* request("/?q=report%20tool", workspace.member);
      assert.strictEqual(found.status, 308);
      assert.strictEqual(found.headers.location, "/patches?q=report%20tool");
      // Old links to the index still land.
      assert.strictEqual((yield* request("/?all=1", workspace.member)).status, 200);
    })
  );

  it.effect("offers About on every Home list's menu, and Settings only to owners and admins", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const page = yield* publish(workspace.owner, "office-map");
      const tool = yield* publishTier2(workspace.owner, "desk-booker");
      for (const [person, list, shown] of [
        [workspace.member, "colleagues", false],
        [workspace.owner, "yours", true],
        [workspace.admin, "colleagues", true]
      ] as const) {
        const html = yield* (yield* request("/", person)).text;
        for (const patch of [page, tool]) {
          const menu = menuItems(html, `${list}-${patch.patchId}`);
          assert.include(
            menu,
            `Open in a new tab Copy link${shown ? " Share…" : ""} About this patch`,
            list
          );
          assert.strictEqual(menu.includes("Settings"), shown, list);
        }
        assert.isTrue(links(html).some((link) => link.href === cardPath(tool.name)));
      }
    })
  );

  it.effect("calls a patch by its title on Home's rows and menus", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const titled = yield* publish(workspace.owner, "office-map", {
        title: "Office <map>",
        description: "Find a desk. Keep the second sentence on the card."
      });
      const home = yield* (yield* request("/", workspace.member)).text;
      assert.include(home, `/office-map">Office &lt;map&gt;</a>`);
      assert.include(menuItems(home, `colleagues-${titled.patchId}`), "Office &lt;map&gt;");
      assert.include(text(home), "Office &lt;map&gt; Find a desk");
      assert.notInclude(text(home), "Keep the second sentence");
    })
  );

  it.effect("puts an owner's tools that failed in the last 24 hours first, with their log", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const failing = yield* publishTier2(workspace.owner, "client-health");
      const fine = yield* publishTier2(workspace.owner, "web-analytics");
      yield* invoke(seedOf(workspace.id, failing), workspace.member, {
        handler: "accounts.burn",
        kind: "action",
        outcome: "failure"
      });
      yield* TestClock.adjust(2 * DAY);
      for (let index = 0; index < 3; index++)
        yield* invoke(seedOf(workspace.id, failing), workspace.member, {
          handler: "accounts.burn",
          kind: "action",
          outcome: "handler_error",
          outcomeCode: "warehouse_timeout"
        });
      yield* invoke(seedOf(workspace.id, fine), workspace.member, {
        handler: "visits.load",
        kind: "action"
      });

      // The owner's Home leads with it, counting only the last day, with its failed log.
      const home = yield* (yield* request("/", workspace.owner)).text;
      assert.isTrue(home.indexOf('id="attention"') < home.indexOf('id="yours"'));
      assert.deepStrictEqual(names(home, "attention"), ["client-health"]);
      assert.include(
        text(sectionOf(home, "attention")),
        "client-health 3 calls failed in the last 24 hours View log"
      );
      assert.isTrue(
        links(sectionOf(home, "attention")).some(
          (link) => link.href === "/patches/client-health/log?outcome=failed"
        )
      );
      assert.include(
        text(sectionOf(home, "yours")),
        "client-health Find the right person 3 failed"
      );
      // An admin manages it but doesn't own it; neither they nor a member are asked to fix it.
      for (const person of [workspace.member, workspace.admin])
        assert.strictEqual(sectionOf(yield* (yield* request("/", person)).text, "attention"), "");
    })
  );

  it.effect("asks an admin to fix a connection that stopped, and leaves members out of it", () =>
    Effect.gen(function* () {
      const workspace = yield* company("cmp_portal_home");
      const admin = yield* (yield* request("/", workspace.admin)).text;
      assert.include(
        text(sectionOf(admin, "attention")),
        "imap/support Paused: the mail server refused the password Replace password…"
      );
      assert.isTrue(
        links(sectionOf(admin, "attention")).some(
          (link) =>
            link.href === "/settings/integrations/con_home_mailbox/rotate" &&
            link.text === "Replace password…"
        )
      );
      assert.strictEqual(
        sectionOf(yield* (yield* request("/", workspace.member)).text, "attention"),
        ""
      );
    })
  );

  it.effect("moves a patch between a tool and a page with its tier", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const page = yield* publish(workspace.owner, "grows-up", {
        manifest: { ...manifest, name: "grows-up", tier: 1 }
      });
      // A page has no calls to count, so the viewer who owns only pages has no such column.
      const before = yield* (yield* request("/", workspace.owner)).text;
      assert.include(text(sectionOf(before, "yours")), "grows-up Find the right person Company");
      assert.notInclude(text(sectionOf(before, "yours")), "Failures");
      yield* publish(workspace.owner, page.name, {
        intent: "update",
        patchId: page.patchId,
        filename: null,
        manifest: { ...manifest, name: page.name, tier: 2, handlers: {} },
        server: {
          objectKey: `patches/${page.patchId}/grows-up.server.js`,
          sha256: sha256(""),
          bytes: 0
        }
      });
      const after = yield* (yield* request("/", workspace.owner)).text;
      assert.include(
        text(sectionOf(after, "yours")),
        "grows-up Find the right person Company No calls yet"
      );
    })
  );
});

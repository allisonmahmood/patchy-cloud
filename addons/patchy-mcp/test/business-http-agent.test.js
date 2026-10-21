// Opt in only on a new disposable `pnpm dev up brightline` Cloud. No build/pack:
// PATCHY_TEST_BUSINESS_CLOUD=<local URL> PATCHY_TEST_BUSINESS_DISPOSABLE=1 \
// PATCHY_TEST_BUSINESS_AGENT=1 PATCHY_TEST_MCP_COMMAND=<isolated prefix>/bin/patchy-mcp \
// PATCHY_TEST_CODEX_COMMAND=<compatible codex> PATCHY_TEST_BUSINESS_EVIDENCE=<dir> \
// node --test test/business-http-agent.test.js
// Install the retained 0.4.2 archive offline first, exactly as SETUP.md describes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { enabled } from "./support/business.js";
import { ask as modelAsk } from "./support/model-agent.js";
import { httpBusiness } from "./support/http-business.js";

const optedIn = enabled && process.env.PATCHY_TEST_BUSINESS_AGENT === "1";
const writes = (run) =>
  run.calls.filter((c) => c.name.endsWith("__run_mutation"));
const result = (call) =>
  call.result?.structured_content || call.result?.structuredContent;
const mutationRequests = (requests) =>
  requests.filter((r) => r.method === "POST" && r.path.endsWith("/mutation"));

test(
  "packaged HTTP + real model + unchanged Brightline CRM: consent, business rules, clarification and restart",
  {
    skip: !optedIn,
    timeout: 1200000,
  },
  async (t) => {
    assert.ok(
      process.env.PATCHY_TEST_MCP_COMMAND,
      "Select an installed archive, never source/dist",
    );
    const entry = await realpath(process.env.PATCHY_TEST_MCP_COMMAND);
    assert.match(entry, /\/lib\/node_modules\/patchy-mcp\/dist\/cli\.js$/);
    const manifest = JSON.parse(
      await readFile(
        new URL("../artifacts/patchy-mcp-0.4.2.json", import.meta.url),
        "utf8",
      ),
    );
    const archive = await readFile(
      new URL("../artifacts/patchy-mcp-0.4.2.tgz", import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(archive).digest("hex"),
      manifest.sha256,
    );
    const http = await httpBusiness(t, entry);
    // Cloud's normal protected-API budget is 60/minute, shared by all three
    // users here. Leave room for a complete model turn and verification reads.
    // Never retry a model-generated mutation to work around throttling.
    const ask = async (...args) => {
      for (;;) {
        const recent = (await http.requests()).filter(
          (r) => r.path.startsWith("/api/") && r.at > Date.now() - 61000,
        );
        if (recent.length <= 20) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return modelAsk(...args);
    };
    assert.equal(http.health.version, manifest.version);
    assert.equal(http.health.buildId, manifest.buildId);
    const admin = await http.connect(
      "allison@brightline.example",
      "read-write",
    );
    const readOnly = await http.connect(
      "jordan@brightline.example",
      "read-only",
    );
    const member = await http.connect(
      "jordan@brightline.example",
      "read-write",
    );
    assert.notEqual(admin.userId, member.userId);
    assert.equal(member.userId, readOnly.userId);
    const { patches } = await admin.value("list_patches", {});
    const patch = patches.find((p) => p.name === "new-business");
    assert.ok(patch);
    const board = () => admin.query(patch.id, "deals.board");
    const timeline = (deal) =>
      admin.query(patch.id, "deals.timeline", { deal });
    const baseline = await board();
    assert.deepEqual(await member.query(patch.id, "deals.board"), baseline);
    const client = `MCP HTTP ${randomUUID().slice(0, 8)}`;
    const created = await ask(
      admin,
      `Use Patchy MCP to add two leads to our new-business pipeline for client ${client}: Website audit (Website service, Inbound source, worth $1,000) and Brand audit (Brand identity service, Referral source, worth $2,000). Assign both to Allison Mahmood. Leave next steps and expected close dates empty. Tell me what you created.`,
      "http-01-create",
    );
    assert.ok(writes(created).length > 0);
    let rows = (await board()).deals.filter((d) => d.client === client);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((d) => d.title).sort(), [
      "Brand audit",
      "Website audit",
    ]);
    assert.ok(
      rows.every((d) => d.owner === admin.userId && d.stage === "lead"),
    );
    assert.equal(rows.find((d) => d.title === "Website audit").value, 1000);
    assert.equal(rows.find((d) => d.title === "Brand audit").value, 2000);
    const website = rows.find((d) => d.title === "Website audit");
    const brand = rows.find((d) => d.title === "Brand audit");

    const read = await ask(
      readOnly,
      `Use Patchy MCP: what deals do we have for ${client}, what are they worth, and who owns them?`,
      "http-02-shared-read",
    );
    assert.equal(writes(read).length, 0);
    for (const text of [
      /Website audit/,
      /Brand audit/,
      /Allison/,
      /1,?000/,
      /2,?000/,
    ])
      assert.match(read.answer, text);
    const beforeConsent = await board(),
      beforeConsentTimeline = await timeline(website.id);
    const beforePosts = mutationRequests(await http.requests()).length;
    const deniedConsent = await ask(
      readOnly,
      `Use Patchy MCP to set the next step of ${client}'s Website audit deal to "Read-only consent probe".`,
      "http-03-read-only-consent",
    );
    assert.equal(
      writes(deniedConsent).length,
      1,
      "Exercise actual model-generated mutation against read-only consent",
    );
    assert.equal(result(writes(deniedConsent)[0]).outcome, "not_attempted");
    assert.equal(
      result(writes(deniedConsent)[0]).error.code,
      "insufficient_scope",
    );
    assert.match(
      deniedConsent.answer,
      /read.only|permission|consent|reconnect/i,
    );
    assert.equal(
      mutationRequests(await http.requests()).length,
      beforePosts,
      "No mutation POST may reach Cloud under read-only consent",
    );
    assert.deepEqual(await board(), beforeConsent);
    assert.deepEqual(await timeline(website.id), beforeConsentTimeline);

    for (const [label, persona, prompt] of [
      [
        "http-04-ambiguous",
        member,
        `Use Patchy MCP to set the next step on ${client}'s deal to "Send quote Friday".`,
      ],
      [
        "http-05-missing-inputs",
        admin,
        `Use Patchy MCP to add a deal for ${client} Missing.`,
      ],
    ]) {
      const before = await board();
      const activity = await Promise.all(rows.map((d) => timeline(d.id)));
      const clarification = await ask(persona, prompt, label);
      assert.equal(writes(clarification).length, 0);
      assert.match(
        clarification.answer,
        /\?|which|need|provide|specify|choose/i,
      );
      assert.deepEqual(await board(), before);
      assert.deepEqual(
        await Promise.all(rows.map((d) => timeline(d.id))),
        activity,
      );
    }
    const edited = await ask(
      member,
      `Use Patchy MCP to set the next step of ${client}'s Website audit deal to "Call Thursday".`,
      "http-06-shared-edit",
    );
    assert.equal(writes(edited).length, 1);
    assert.equal(result(writes(edited)[0]).outcome, "committed");
    assert.equal(
      (await board()).deals.find((d) => d.id === website.id).nextStep,
      "Call Thursday",
    );
    assert.ok(
      (await timeline(website.id)).events.some(
        (e) => e.kind === "edited" && e.actor === member.userId,
      ),
    );

    for (const [label, prompt] of [
      [
        "http-07-member-close",
        `Use Patchy MCP to mark ${client}'s Website audit deal as won.`,
      ],
      [
        "http-08-member-reassign",
        `Use Patchy MCP to reassign ${client}'s Brand audit deal from Allison Mahmood to Jordan Lee.`,
      ],
    ]) {
      const before = await board();
      const activity = await Promise.all(rows.map((d) => timeline(d.id)));
      const refused = await ask(member, prompt, label);
      assert.equal(
        writes(refused).length,
        1,
        "The Tool must receive and enforce its own permission rule",
      );
      assert.equal(result(writes(refused)[0]).outcome, "rolled_back");
      assert.equal(
        result(writes(refused)[0]).error.code,
        "owner_or_admin_only",
      );
      assert.match(refused.answer, /owner|admin|permission|Allison/i);
      assert.deepEqual(await board(), before);
      assert.deepEqual(
        await Promise.all(rows.map((d) => timeline(d.id))),
        activity,
      );
    }
    const closed = await ask(
      admin,
      `Use Patchy MCP to mark ${client}'s Website audit deal as won.`,
      "http-09-admin-close",
    );
    assert.equal(writes(closed).length, 1);
    assert.equal(result(writes(closed)[0]).outcome, "committed");
    assert.equal(
      (await board()).deals.find((d) => d.id === website.id).stage,
      "won",
    );
    const reassigned = await ask(
      admin,
      `Use Patchy MCP to reassign ${client}'s Brand audit deal to Jordan Lee.`,
      "http-10-admin-reassign",
    );
    assert.equal(writes(reassigned).length, 1);
    assert.equal(
      (await board()).deals.find((d) => d.id === brand.id).owner,
      member.userId,
    );
    const ownerClose = await ask(
      member,
      `Use Patchy MCP to mark ${client}'s Brand audit deal as won.`,
      "http-11-owner-close",
    );
    assert.equal(writes(ownerClose).length, 1);
    assert.equal(result(writes(ownerClose)[0]).outcome, "committed");
    assert.equal(
      (await board()).deals.find((d) => d.id === brand.id).stage,
      "won",
    );

    const beforeDelete = await board(),
      beforeDeleteTimeline = await timeline(website.id);
    const deleted = await ask(
      admin,
      `Use Patchy MCP to delete ${client}'s Website audit test deal.`,
      "http-12-unsupported-delete",
    );
    assert.equal(writes(deleted).length, 0);
    assert.match(deleted.answer, /delet/i);
    assert.match(
      deleted.answer,
      /no\b|not\b|unavailable|can't|cannot|doesn't|isn't/i,
    );
    assert.deepEqual(await board(), beforeDelete);
    assert.deepEqual(await timeline(website.id), beforeDeleteTimeline);
    const unsupported = await admin.mutate(patch.id, "deals.delete", {
      deal: website.id,
    });
    assert.equal(unsupported.structuredContent.outcome, "not_attempted");
    assert.equal(unsupported.structuredContent.error.code, "invalid_operation");

    const connectionsBefore = await http.stateSummary();
    await http.restart();
    assert.deepEqual(await http.stateSummary(), connectionsBefore);
    const restarted = await ask(
      member,
      `Use Patchy MCP: what deals do we have for ${client}, their current stages, next steps and owners?`,
      "http-13-after-restart",
    );
    assert.equal(writes(restarted).length, 0);
    assert.match(restarted.answer, /Website audit/);
    assert.match(restarted.answer, /Brand audit/);
    assert.match(restarted.answer, /Jordan/);
    await readOnly.refresh();
    const stillReadOnly = await readOnly.mutate(patch.id, "deals.move", {
      deal: brand.id,
      stage: "lead",
    });
    assert.equal(
      stillReadOnly.structuredContent.error.code,
      "insufficient_scope",
    );
    await member.refresh();
    assert.deepEqual(
      await member.query(patch.id, "deals.board"),
      await board(),
    );
    assert.deepEqual(
      (await board()).deals.filter((d) => d.client !== client),
      baseline.deals,
    );
    const summary = {
      verdict: "PASS",
      version: manifest.version,
      buildId: manifest.buildId,
      archiveSha256: manifest.sha256,
      cloud: http.health.instanceUrl,
      modelTurns: 13,
      preExistingDeals: baseline.deals.length,
      createdDeals: 2,
      connections: 3,
      requests: await http.requests(),
    };
    if (process.env.PATCHY_TEST_BUSINESS_EVIDENCE)
      await writeFile(
        `${process.env.PATCHY_TEST_BUSINESS_EVIDENCE}/summary.json`,
        JSON.stringify(summary, null, 2),
      );
    console.log(
      JSON.stringify({
        ...summary,
        requests: {
          total: summary.requests.length,
          mutations: mutationRequests(summary.requests).length,
        },
      }),
    );
  },
);

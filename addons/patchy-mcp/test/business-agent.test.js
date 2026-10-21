import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { connect, enabled } from "./support/business.js";
import { ask } from "./support/model-agent.js";

const agentEnabled = enabled && process.env.PATCHY_TEST_BUSINESS_AGENT === "1";

const writes = (run) =>
  run.calls.filter((c) => c.name.endsWith("__run_mutation"));

test(
  "ordinary language on the existing CRM: discover/read/create/edit, clarify ambiguity/inputs, preserve permissions and report unavailable deletion",
  { skip: !agentEnabled, timeout: 900000 },
  async (t) => {
    const admin = await connect(t, "allison@brightline.example");
    const member = await connect(t, "jordan@brightline.example");
    const { patches } = await admin.value("list_patches", {});
    const patch = patches.find((p) => p.name === "new-business");
    assert.ok(patch);
    const baseline = await admin.query(patch.id, "deals.board");
    const client = `MCP Ordinary ${randomUUID().slice(0, 8)}`;
    const board = () => admin.query(patch.id, "deals.board");
    const added = await ask(
      admin,
      `Use Patchy MCP to add two leads to our new-business pipeline for client ${client}: Website audit (Website service, Inbound source, worth $1,000) and Brand audit (Brand identity service, Referral source, worth $2,000). Assign both to Allison Mahmood. Leave next steps and expected close dates empty. Tell me what you created.`,
      "01-create",
    );
    assert.ok(
      writes(added).length > 0,
      "Creation must execute a declared mutation; the Tool also supports an atomic batch import",
    );
    let rows = (await board()).deals.filter((d) => d.client === client);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((d) => d.title).sort(), [
      "Brand audit",
      "Website audit",
    ]);
    assert.ok(
      rows.every((d) => d.owner === admin.userId && d.stage === "lead"),
    );
    const read = await ask(
      member,
      `Use Patchy MCP: what deals do we have for ${client}, what are they worth, and who owns them?`,
      "02-shared-read",
    );
    assert.equal(writes(read).length, 0);
    assert.match(read.answer, /Website audit/);
    assert.match(read.answer, /Brand audit/);
    assert.match(read.answer, /Allison/);
    const ambiguous = await ask(
      member,
      `Use Patchy MCP to set the next step on ${client}'s deal to "Send quote Friday".`,
      "03-ambiguous",
    );
    assert.equal(
      writes(ambiguous).length,
      0,
      "An ambiguous name must not select the first match",
    );
    assert.match(ambiguous.answer, /\?|which|specify|choose/i);
    assert.deepEqual(
      (await board()).deals.filter((d) => d.client === client),
      rows,
    );
    const missing = await ask(
      admin,
      `Use Patchy MCP to add a deal for ${client} Missing.`,
      "04-missing-inputs",
    );
    assert.equal(
      writes(missing).length,
      0,
      "Missing business inputs must be clarified",
    );
    assert.match(missing.answer, /\?|need|provide|specify/i);
    assert.ok(
      !(await board()).deals.some((d) => d.client === `${client} Missing`),
    );
    const edited = await ask(
      member,
      `Use Patchy MCP to set the next step of ${client}'s Website audit deal to "Call Thursday".`,
      "05-shared-edit",
    );
    assert.equal(writes(edited).length, 1);
    rows = (await board()).deals.filter((d) => d.client === client);
    const website = rows.find((d) => d.title === "Website audit");
    assert.equal(website.nextStep, "Call Thursday");
    assert.equal(rows.find((d) => d.title === "Brand audit").nextStep, null);
    const denied = await ask(
      member,
      `Use Patchy MCP to mark ${client}'s Website audit deal as won.`,
      "06-member-close",
    );
    assert.equal(
      (await board()).deals.find((d) => d.id === website.id).stage,
      "lead",
    );
    assert.match(denied.answer, /owner|admin|permission|Allison/i);
    const closed = await ask(
      admin,
      `Use Patchy MCP to mark ${client}'s Website audit deal as won.`,
      "07-admin-close",
    );
    assert.equal(writes(closed).length, 1);
    assert.equal(
      (await board()).deals.find((d) => d.id === website.id).stage,
      "won",
    );
    const beforeDelete = await board();
    const deleted = await ask(
      admin,
      `Use Patchy MCP to delete ${client}'s Website audit test deal.`,
      "08-unavailable-delete",
    );
    assert.equal(
      writes(deleted).length,
      0,
      "The existing Tool has no delete mutation",
    );
    assert.match(deleted.answer, /delet/i);
    assert.match(
      deleted.answer,
      /no\b|not\b|unavailable|can't|cannot|doesn't|isn't/i,
    );
    assert.deepEqual(await board(), beforeDelete);
    assert.deepEqual(
      (await board()).deals.filter((d) => d.client !== client),
      baseline.deals,
      "Pre-existing records survive all model turns",
    );
  },
);

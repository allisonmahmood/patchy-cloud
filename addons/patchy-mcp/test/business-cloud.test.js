import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { connect, enabled } from "./support/business.js";

test(
  "existing Brightline CRM: discovery, shared reads/edits, owner/admin rules and no invented delete",
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const admin = await connect(t, "allison@brightline.example");
    const member = await connect(t, "jordan@brightline.example");
    const inventory = await member.value("list_patches", {});
    const patch = inventory.patches.find((p) => p.name === "new-business");
    assert.ok(patch, "Seed the unchanged brightline/new-business Tool first");
    const catalog = await member.operations(patch.id);
    assert.equal(catalog.patchId, patch.id);
    for (const handler of [
      "deals.board",
      "deals.create",
      "deals.update",
      "deals.move",
      "deals.assign",
    ]) {
      const operation = catalog.operations.find((o) => o.handler === handler);
      assert.ok(operation, handler);
      assert.ok(operation.description.length);
      assert.equal(operation.inputSchema.type, "object");
    }
    assert.ok(
      catalog.operations.every((o) => ["query", "mutation"].includes(o.kind)),
    );
    const baseline = await admin.query(patch.id, "deals.board");
    assert.deepEqual(await member.query(patch.id, "deals.board"), baseline);
    assert.ok(
      baseline.deals.some((d) => d.owner !== member.userId),
      "Shared reads include colleagues' deals",
    );
    const draft = {
      client: `MCP acceptance ${randomUUID()}`,
      title: "Website audit",
      service: "Website",
      value: 1000,
      source: "Inbound",
      nextStep: null,
      expectedClose: null,
    };
    const created = await admin.mutate(patch.id, "deals.create", {
      ...draft,
      owner: admin.userId,
    });
    assert.equal(
      created.structuredContent.outcome,
      "committed",
      JSON.stringify(created),
    );
    const row = created.structuredContent.value;
    const updated = await member.mutate(patch.id, "deals.update", {
      ...draft,
      deal: row.id,
      nextStep: "Call Thursday",
    });
    assert.equal(
      updated.structuredContent.outcome,
      "committed",
      "Any studio member may edit details",
    );
    const before = await admin.query(patch.id, "deals.timeline", {
      deal: row.id,
    });
    assert.ok(
      before.events.some(
        (event) => event.kind === "edited" && event.actor === member.userId,
      ),
      "Writes are attributed to the calling member",
    );
    for (const [handler, args] of [
      ["deals.move", { deal: row.id, stage: "won" }],
      ["deals.assign", { deal: row.id, owner: member.userId }],
    ]) {
      const refused = await member.mutate(patch.id, handler, args);
      assert.equal(refused.isError, true);
      assert.equal(refused.structuredContent.outcome, "rolled_back");
      assert.equal(refused.structuredContent.error.code, "owner_or_admin_only");
      assert.deepEqual(
        await admin.query(patch.id, "deals.timeline", { deal: row.id }),
        before,
        "Refusal leaves activity unchanged",
      );
    }
    const won = await admin.mutate(patch.id, "deals.move", {
      deal: row.id,
      stage: "won",
    });
    assert.equal(won.structuredContent.outcome, "committed");
    assert.equal(won.structuredContent.value.stage, "won");
    const missing = await member.mutate(patch.id, "deals.create", {
      client: draft.client,
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.outcome, "refused");
    const unsupported = await admin.mutate(patch.id, "deals.delete", {
      deal: row.id,
    });
    assert.equal(unsupported.structuredContent.outcome, "not_attempted");
    assert.equal(unsupported.structuredContent.error.code, "invalid_operation");
    const after = await member.query(patch.id, "deals.board");
    assert.deepEqual(
      after.deals.filter((d) => d.id !== row.id),
      baseline.deals,
      "All pre-existing deals are preserved",
    );
    assert.equal(after.deals.find((d) => d.id === row.id).stage, "won");
    assert.equal(
      after.deals.find((d) => d.id === row.id).nextStep,
      "Call Thursday",
    );
  },
);

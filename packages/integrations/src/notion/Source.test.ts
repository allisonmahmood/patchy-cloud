import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NotionDouble from "../test/notion.js";
import * as Source from "./Source.js";

it.effect("discovers both search pages and keeps a relation to a source on the next page", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const snapshot = yield* notion.inspect(Redacted.make(NotionDouble.internalToken), "read");
    assert.strictEqual(snapshot.workspace.name, "Notion Probe");
    assert.strictEqual(snapshot.access, "read");
    assert.deepStrictEqual(snapshot.dataSources.map(({ key }) => key).sort(), [
      "Projects",
      "Tasks"
    ]);
    const tasks = snapshot.dataSources.find(({ key }) => key === "Tasks")!;
    const projects = snapshot.dataSources.find(({ key }) => key === "Projects")!;
    assert.strictEqual(tasks.databaseTitle, "Project Tracker");
    assert.strictEqual(tasks.url, "https://app.notion.com/p/d52c7f0776a54f6fb33d88d496058f41");
    assert.deepStrictEqual(snapshot.exclusions, [
      { source: "Tasks", name: "Days open", reason: "unsupported_type" },
      { source: "Tasks", name: "Internal project", reason: "unshared_relation" }
    ]);
    assert.strictEqual(
      tasks.properties.find(({ name }) => name === "Project")?.relationTarget,
      projects.id
    );
    assert.deepStrictEqual(tasks.properties.find(({ type }) => type === "status")?.groups, [
      { id: "todo-group", name: "To do", optionIds: ["todo"] },
      { id: "done-group", name: "Complete", optionIds: ["done"] }
    ]);
  }).pipe(Effect.provide(NotionDouble.layer))
);

it.effect("refuses personal keys and replacement keys from another workspace", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const personal = yield* notion
      .inspect(Redacted.make(NotionDouble.personalToken), "read")
      .pipe(Effect.flip);
    assert.strictEqual(personal.code, "notion_not_workspace_key");
    const other = yield* notion
      .inspect(Redacted.make(NotionDouble.internalToken), "read", "a-different-workspace")
      .pipe(Effect.flip);
    assert.strictEqual(other.code, "notion_other_workspace");
  }).pipe(Effect.provide(NotionDouble.layer))
);

it.effect("refuses a second search page that exceeds the discovery bound", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const failure = yield* notion
      .inspect(Redacted.make(NotionDouble.internalToken), "read")
      .pipe(Effect.flip);
    assert.strictEqual(failure.code, "too_large");
    assert.strictEqual(
      failure.message,
      "Notion discovery exceeded the Patchy limit for data sources (1). Nothing was saved."
    );
  }).pipe(
    Effect.provide(NotionDouble.layer),
    Effect.provideService(ContractLimits.overrides, { "notion.discovery.sources": 1 })
  )
);

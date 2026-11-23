import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as NotionSource from "../src/notion/Source.js";

it.live("discovers the disposable Notion workspace through its internal connection", () =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("NOTION_TEST_INTERNAL_TOKEN");
    const notion = yield* NotionSource.Source;
    const snapshot = yield* notion.inspect(token, "read");
    assert.equal(snapshot.access, "read");
    assert.isNotEmpty(snapshot.workspace.id);
    assert.isNotEmpty(snapshot.botId);
    assert.isTrue(
      snapshot.dataSources.some(
        (source) =>
          source.title === "Tasks" &&
          source.properties.some((property) => property.type === "title")
      )
    );
  }).pipe(Effect.provide(NotionSource.layer))
);

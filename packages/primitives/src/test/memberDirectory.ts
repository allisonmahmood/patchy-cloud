import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemberDirectory from "../MemberDirectory.js";

const unexpected = Effect.die("Unexpected member-directory access in a table-only test");

/** Non-directory suites allow fixed authority revisions but refuse reading company members. */
export const layer = Layer.succeed(MemberDirectory.MemberDirectory, {
  list: () => unexpected,
  search: () => unexpected,
  get: () => unexpected,
  getMany: () => unexpected,
  candidates: () => unexpected,
  revision: () => Effect.succeed("0")
});

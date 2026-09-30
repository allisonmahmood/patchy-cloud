import { Directory } from "@patchy/companies";
import { ContractLimits } from "@patchy/limits";
import { MemberDirectory } from "@patchy/primitives";
import { Runtime } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Companies owns the directory; Primitives owns its runtime policy and page bound. */
export const make = Effect.gen(function* () {
  const directory = yield* Directory.Directory;
  const pageSize = yield* ContractLimits.get("members.page");
  const cursorErrors = {
    DirectoryInvalidCursor: (cause: Directory.InvalidCursor) =>
      Effect.fail(new MemberDirectory.InvalidCursor({ cause })),
    SqlError: (cause: unknown) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
  };
  return MemberDirectory.MemberDirectory.of({
    list: (companyId, cursor) =>
      directory.list(companyId, pageSize, cursor).pipe(Effect.catchTags(cursorErrors)),
    search: (companyId, text, cursor) =>
      directory.search(companyId, text, pageSize, cursor).pipe(Effect.catchTags(cursorErrors)),
    get: (companyId, id) =>
      directory
        .get(companyId, id)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
    getMany: (companyId, ids) =>
      directory
        .getMany(companyId, ids)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
    isCandidate: (companyId, id) =>
      directory
        .isCandidate(companyId, id)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
    revision: (companyId) =>
      directory
        .revision(companyId)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
  });
});

export const layer = Layer.effect(MemberDirectory.MemberDirectory, make).pipe(
  Layer.provide(Directory.layer)
);

import { Directory } from "@patchy/companies";
import { ContractLimits } from "@patchy/limits";
import { GuestGrants } from "@patchy/patches";
import { MemberDirectory } from "@patchy/primitives";
import { Runtime } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";

type Patch = { readonly companyId: string; readonly patchId: string };

/**
 * Companies owns the directory and Patches the grants that bring guests into it, neither knowing
 * the other; Primitives owns its runtime policy and page bound.
 */
export const make = Effect.gen(function* () {
  const directory = yield* Directory.Directory;
  const grants = yield* GuestGrants.GuestGrants;
  const pageSize = yield* ContractLimits.get("members.page");
  const unavailable = Effect.mapError((cause: unknown) => new Runtime.SourceUnavailable({ cause }));
  const pageErrors = <A>(page: Effect.Effect<A, Directory.InvalidCursor | SqlError>) =>
    page.pipe(
      Effect.catchTags({
        DirectoryInvalidCursor: (cause) =>
          Effect.fail(new MemberDirectory.InvalidCursor({ cause })),
        SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
      })
    );
  /** A patch's pickers and assignments: its company's members and its active guests. */
  const ofPatch = (patch: Patch) =>
    Effect.map(grants.guests(patch.patchId), (guests): Directory.Scope => ({
      companyId: patch.companyId,
      guests: new Map(guests.map(({ userId }) => [userId, true]))
    }));
  /**
   * A patch's resolution: its company's members and anyone holding one of the company's grants,
   * ended or not, active only by their grant on this patch.
   */
  const resolving = (patch: Patch, ids: readonly string[]) =>
    Effect.map(grants.holders(patch, ids), (guests): Directory.Scope => ({
      companyId: patch.companyId,
      guests
    }));
  return MemberDirectory.MemberDirectory.of({
    list: (patch, cursor) =>
      ofPatch(patch).pipe(
        Effect.flatMap((scope) => directory.list(scope, pageSize, cursor)),
        pageErrors
      ),
    search: (patch, text, cursor) =>
      ofPatch(patch).pipe(
        Effect.flatMap((scope) => directory.search(scope, text, pageSize, cursor)),
        pageErrors
      ),
    get: (patch, id) =>
      resolving(patch, [id]).pipe(
        Effect.flatMap((scope) => directory.get(scope, id)),
        unavailable
      ),
    getMany: (patch, ids) =>
      resolving(patch, ids).pipe(
        Effect.flatMap((scope) => directory.getMany(scope, ids)),
        unavailable
      ),
    candidates: (patch, ids) =>
      ofPatch(patch).pipe(
        Effect.flatMap((scope) => directory.candidates(scope, ids)),
        unavailable
      ),
    revision: (companyId) => directory.revision(companyId).pipe(unavailable)
  });
});

/** The host supplies Patches' grants, beside the runtime that reads this. */
export const layer = Layer.effect(MemberDirectory.MemberDirectory, make).pipe(
  Layer.provide(Directory.layer)
);

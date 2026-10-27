import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { SqlError } from "effect/sql/SqlError";
import type { RuntimeMe } from "@patchy/api";
import { RequireSession } from "@patchy/auth";

export interface Target {
  readonly patchId: string;
  readonly versionId: string;
}

/** The host may admit a named recipient to this exact patch. It creates no membership.
 * The default preserves the company-only runtime; only the local prototype provides it.
 */
export const recipient = Context.Reference<
  (
    claims: RequireSession.SignedIn["Service"],
    target: Target
  ) => Effect.Effect<NonNullable<RuntimeMe> | null, SqlError>
>("@patchy/runtime/PatchAccess/recipient", { defaultValue: () => () => Effect.succeed(null) });

export const admit: (
  claims: RequireSession.SignedIn["Service"],
  target?: Target
) => Effect.Effect<
  { readonly viewer: NonNullable<RuntimeMe>; readonly externalRecipient: boolean } | null,
  SqlError,
  Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
> = Effect.fn("PatchAccess.admit")(function* (
  claims: RequireSession.SignedIn["Service"],
  target?: Target
) {
  const member = yield* RequireSession.resolveViewer.pipe(
    Effect.provideService(RequireSession.SignedIn, claims)
  );
  if (target !== undefined) {
    const external = yield* (yield* recipient)(claims, target);
    if (external !== null) return { viewer: external, externalRecipient: true };
  }
  if (HttpServerResponse.isHttpServerResponse(member)) return null;
  return member === null
    ? null
    : {
        viewer: { user: member.user, company: member.company, admin: member.role === "admin" },
        externalRecipient: false
      };
});

import type { Member, MembersPage } from "@patchy/api";
import type { Binding, Runtime } from "@patchy/runtime/core";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()(
  "MemberDirectoryInvalidCursor",
  {
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "Invalid member directory cursor; use a cursor from the same company and search.";
  }
}

/** The patch a read is for: its company's members, and the guests it's shared with. */
type Patch = Pick<Binding.Binding["Service"], "companyId" | "patchId">;

/**
 * Platform-backed in production; the mount identities in local development. Pickers and
 * assignment checks offer the patch's active guests. Resolution names anyone holding one of its
 * company's grants, so a patch reading another's shared table names that patch's guests too, but
 * a guest is active, with their email, only in a patch they're currently shared with.
 */
export class MemberDirectory extends Context.Service<
  MemberDirectory,
  {
    readonly list: (
      patch: Patch,
      cursor?: string
    ) => Effect.Effect<typeof MembersPage.Type, Runtime.RuntimeError>;
    readonly search: (
      patch: Patch,
      text: string,
      cursor?: string
    ) => Effect.Effect<typeof MembersPage.Type, Runtime.RuntimeError>;
    readonly get: (
      patch: Patch,
      id: string
    ) => Effect.Effect<typeof Member.Type | null, Runtime.RuntimeError>;
    readonly getMany: (
      patch: Patch,
      ids: readonly string[]
    ) => Effect.Effect<readonly (typeof Member.Type | null)[], Runtime.RuntimeError>;
    readonly candidates: (
      patch: Patch,
      ids: readonly string[]
    ) => Effect.Effect<readonly string[], Runtime.RuntimeError>;
    readonly revision: (companyId: string) => Effect.Effect<string, Runtime.RuntimeError>;
  }
>()("@patchy/primitives/MemberDirectory") {}

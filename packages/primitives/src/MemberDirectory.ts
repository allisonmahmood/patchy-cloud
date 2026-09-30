import type { Member, MembersPage } from "@patchy/api";
import type { Runtime } from "@patchy/runtime/core";
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

/** Platform-backed in production; the two mount identities in local development. */
export class MemberDirectory extends Context.Service<
  MemberDirectory,
  {
    readonly list: (
      companyId: string,
      cursor?: string
    ) => Effect.Effect<typeof MembersPage.Type, Runtime.RuntimeError>;
    readonly search: (
      companyId: string,
      text: string,
      cursor?: string
    ) => Effect.Effect<typeof MembersPage.Type, Runtime.RuntimeError>;
    readonly get: (
      companyId: string,
      id: string
    ) => Effect.Effect<typeof Member.Type | null, Runtime.RuntimeError>;
    readonly getMany: (
      companyId: string,
      ids: readonly string[]
    ) => Effect.Effect<readonly (typeof Member.Type | null)[], Runtime.RuntimeError>;
    readonly isCandidate: (
      companyId: string,
      id: string
    ) => Effect.Effect<boolean, Runtime.RuntimeError>;
    readonly revision: (companyId: string) => Effect.Effect<string, Runtime.RuntimeError>;
  }
>()("@patchy/primitives/MemberDirectory") {}

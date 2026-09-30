import type { Identity, Member } from "@patchy/api";
import { MemberDirectory } from "@patchy/primitives";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const colleague = {
  id: "usr_dev_colleague",
  name: "Dev Colleague",
  email: "colleague@patchy.local"
} as const;

/** Dev has two candidates and no authority changes or production directory reads. */
export const layer = (identity: typeof Identity.Type) => {
  const rows: readonly (typeof Member.Type)[] = [
    { ...identity.user, admin: identity.role === "admin", active: true },
    { ...colleague, admin: false, active: true }
  ].sort((left, right) => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const byId = new Map(rows.map((member) => [member.id, member]));
  const authorize = (companyId: string) =>
    companyId === identity.company.id ? Effect.void : Effect.fail(new Runtime.AccessDenied({}));
  const page = Effect.fnUntraced(function* (companyId: string, text: string, cursor?: string) {
    yield* authorize(companyId);
    if (cursor !== undefined) return yield* new MemberDirectory.InvalidCursor({});
    const prefix = text.toLowerCase();
    return {
      rows:
        prefix === ""
          ? rows
          : rows.filter(
              (member) =>
                member.name.toLowerCase().startsWith(prefix) ||
                member.email.toLowerCase().startsWith(prefix)
            ),
      cursor: null
    };
  });
  return Layer.succeed(
    MemberDirectory.MemberDirectory,
    MemberDirectory.MemberDirectory.of({
      list: (companyId, cursor) => page(companyId, "", cursor),
      search: page,
      get: (companyId, id) => authorize(companyId).pipe(Effect.as(byId.get(id) ?? null)),
      getMany: (companyId, ids) =>
        authorize(companyId).pipe(Effect.as(ids.map((id) => byId.get(id) ?? null))),
      candidates: (companyId, ids) =>
        authorize(companyId).pipe(Effect.as([...new Set(ids)].filter((id) => byId.has(id)))),
      revision: (companyId) => authorize(companyId).pipe(Effect.as("0"))
    })
  );
};

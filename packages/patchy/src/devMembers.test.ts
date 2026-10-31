import { assert, it } from "@effect/vitest";
import { MemberDirectory } from "@patchy/primitives";
import * as Effect from "effect/Effect";
import * as DevMembers from "./devMembers.js";

const identity = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", handle: "dev", name: "Dev" },
  role: "admin" as const,
  machine: { id: "mch_dev", name: "Dev machine" }
};
const local = { ...identity.user, admin: true, active: true };
const colleague = { ...DevMembers.colleague, admin: false, active: true };
const guest = { ...DevMembers.guest, admin: false, active: true, guest: true as const };
const patch = { companyId: "cmp_dev", patchId: "pat_dev" };

it.effect(
  "lists the local person, the colleague and the guest by name, searched by name or email prefix",
  () =>
    Effect.gen(function* () {
      const directory = yield* MemberDirectory.MemberDirectory;
      assert.deepStrictEqual(yield* directory.list(patch), {
        rows: [local, colleague, guest],
        cursor: null
      });
      assert.deepStrictEqual(yield* directory.search(patch, "COLLEAGUE@"), {
        rows: [colleague],
        cursor: null
      });
      assert.deepStrictEqual(yield* directory.search(patch, "league"), {
        rows: [],
        cursor: null
      });
      assert.deepStrictEqual(
        yield* directory.getMany("cmp_dev", [local.id, "missing", guest.id, local.id]),
        [local, null, guest, local]
      );
      assert.deepStrictEqual(yield* directory.candidates(patch, [guest.id, "missing"]), [guest.id]);
      assert.strictEqual(
        (yield* directory.list({ ...patch, companyId: "cmp_other" }).pipe(Effect.flip)).code,
        "access_denied"
      );
    }).pipe(Effect.provide(DevMembers.layer(identity)))
);

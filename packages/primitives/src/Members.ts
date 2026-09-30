import { runtimeOperations } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as MemberDirectory from "./MemberDirectory.js";

export const authorize = Effect.gen(function* () {
  const binding = yield* Binding.Binding;
  if (
    !Object.hasOwn(binding.manifest.uses, "members") ||
    binding.manifest.uses.members?.kind !== "members"
  )
    return yield* new Runtime.AccessDenied({});
  if (binding.identity === null || binding.identity.company.id !== binding.companyId)
    return yield* new Runtime.AccessDenied({});
  return binding.companyId;
});

export const make = Effect.gen(function* () {
  const directory = yield* MemberDirectory.MemberDirectory;
  const maxItems = yield* ContractLimits.get("members.getMany");
  return {
    "members.list": Runtime.handler(
      {
        kind: "read",
        input: runtimeOperations["members.list"].request.fields.args,
        output: runtimeOperations["members.list"].response
      },
      Effect.fn("Members.list")(function* (args) {
        return yield* directory.list(yield* authorize, args.cursor);
      })
    ),
    "members.search": Runtime.handler(
      {
        kind: "read",
        input: runtimeOperations["members.search"].request.fields.args,
        output: runtimeOperations["members.search"].response
      },
      Effect.fn("Members.search")(function* (args) {
        return yield* directory.search(yield* authorize, args.text, args.cursor);
      })
    ),
    "members.get": Runtime.handler(
      {
        kind: "read",
        input: runtimeOperations["members.get"].request.fields.args,
        output: runtimeOperations["members.get"].response
      },
      Effect.fn("Members.get")(function* (args) {
        return yield* directory.get(yield* authorize, args.id);
      })
    ),
    "members.getMany": Runtime.handler(
      {
        kind: "read",
        input: runtimeOperations["members.getMany"].request.fields.args,
        output: runtimeOperations["members.getMany"].response
      },
      Effect.fn("Members.getMany")(function* (args) {
        const companyId = yield* authorize;
        if (args.ids.length > maxItems)
          return yield* new Runtime.LimitExceeded({ limitId: "members.getMany", value: maxItems });
        return yield* directory.getMany(companyId, args.ids);
      })
    )
  } satisfies Readonly<Record<string, Runtime.Handler>>;
});

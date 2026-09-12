import * as Effect from "effect/Effect";
import { runtimeOperations } from "@patchy/api";
import * as Binding from "./Binding.js";
import * as Runtime from "./Runtime.js";

export const me = Runtime.handler(
  {
    kind: runtimeOperations.me.kind,
    input: runtimeOperations.me.request.fields.args,
    output: runtimeOperations.me.response
  },
  () => Effect.map(Binding.Binding, (binding) => binding.identity)
);

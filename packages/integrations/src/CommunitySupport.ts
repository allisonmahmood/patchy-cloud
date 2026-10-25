import type { CommunityDeclaration, GenerateRequest } from "@patchy/api";
import type { Runtime } from "@patchy/runtime/core";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type * as ConnectionStore from "./ConnectionStore.js";

/** Host-supplied prototype support. Normal startup has no community implementation. */
export const CommunitySupport = Context.Reference<{
  readonly resolve: (
    companyId: string,
    declaration: Extract<
      (typeof GenerateRequest.Type)["manifest"]["uses"][string],
      { kind: "community" }
    >
  ) => Effect.Effect<
    {
      readonly id: string;
      readonly revision: number;
      readonly client: string;
      readonly context: string;
    },
    ConnectionStore.ConnectionNotFound | ConnectionStore.ConnectionNotConnected | SqlError
  >;
  readonly validate: (
    companyId: string,
    declaration: typeof CommunityDeclaration.Type
  ) => Effect.Effect<
    void,
    ConnectionStore.ConnectionNotFound | ConnectionStore.ConnectionNotConnected | SqlError
  >;
  readonly handlers: Readonly<Record<string, Runtime.Handler>>;
} | null>("@patchy/integrations/CommunitySupport", { defaultValue: () => null });
export type Support = NonNullable<typeof CommunitySupport.Service>;

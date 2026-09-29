import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Inventory } from "@patchy/company-database";
import type { Runtime } from "@patchy/runtime/core";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** A read snapshot shares data while invocation authority remains live per callback. */
export class ReadSnapshot extends Context.Service<
  ReadSnapshot,
  {
    readonly companyId: string;
    readonly sql: SqlClient.SqlClient;
    readonly authority?: (
      patchId: string
    ) => Effect.Effect<Inventory.Snapshot | null, Runtime.RuntimeError>;
  }
>()("@patchy/primitives/ReadSnapshot") {}

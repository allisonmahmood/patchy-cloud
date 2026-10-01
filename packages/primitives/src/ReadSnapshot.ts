import * as Context from "effect/Context";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** A subscription reuses its one company connection for access checks and row reads. */
export class ReadSnapshot extends Context.Service<
  ReadSnapshot,
  { readonly companyId: string; readonly sql: SqlClient.SqlClient }
>()("@patchy/primitives/ReadSnapshot") {}

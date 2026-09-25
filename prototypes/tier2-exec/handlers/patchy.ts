// PROTOTYPE for #311: a tiny stand-in for the `t` of the #296 contract.
// Handlers are module-qualified exports of server/*.ts; `t.query`/`t.mutation`
// only tag the kind so the build can enumerate them into a manifest.
export type Row = Record<string, any>;

export type Ctx = {
  viewer: string;
  tables: {
    list(table: string, where?: Row): Promise<Row[]>;
    insert(table: string, row: Row): Promise<Row>;
    update(table: string, where: Row, set: Row): Promise<Row[]>;
  };
  run: { sleep(ms: number): Promise<void>; slowSql(ms: number): Promise<void> };
  log(...args: unknown[]): void;
};

export type Handler<A, R> = {
  kind: "query" | "mutation";
  handler: (ctx: Ctx, args: A) => Promise<R>;
};

export const t = {
  query<A = {}, R = unknown>(def: { handler: (ctx: Ctx, args: A) => Promise<R> }): Handler<A, R> {
    return { kind: "query", handler: def.handler };
  },
  mutation<A = {}, R = unknown>(def: {
    handler: (ctx: Ctx, args: A) => Promise<R>;
  }): Handler<A, R> {
    return { kind: "mutation", handler: def.handler };
  }
};

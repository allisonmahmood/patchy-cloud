// @effect-diagnostics globalFetch:off -- the browser client is dependency-free on purpose; it ships in the patch bundle.
/**
 * PROTOTYPE (#176). The client patch code calls: `patchy.tables.<name>`
 * and `patchy.files.<name>`, typed from the config. It speaks plain HTTP to
 * `/_patchy/*` — in dev that is the local dev runtime behind Vite's proxy.
 * In production the transport is the shell broker (the frame prototype,
 * #175); this fetch transport is a stand-in with the same operations, and
 * swapping it is the one thing `createClient` exists to isolate.
 */
import type { AnyConfig, InsertOf, RowOf, TableDefinition } from "./config.js";

export interface Viewer {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
}

export interface StoredFile {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface TableClient<Row, Insert> {
  /** Inserts one row; the cloud fills `id` and defaults. */
  readonly insert: (row: Insert) => Promise<Row>;
  /** The newest rows first, at most `limit` (default 100, max 1000). */
  readonly list: (options?: { readonly limit?: number }) => Promise<ReadonlyArray<Row>>;
  /** One row by id, or null. */
  readonly get: (id: string) => Promise<Row | null>;
  readonly delete: (id: string) => Promise<void>;
}

export interface FilesClient {
  /** Stores bytes under a name in this store, replacing what the name held. */
  readonly put: (name: string, data: Blob, contentType?: string) => Promise<StoredFile>;
  /** The bytes back as a Blob. Throws `PatchyError` 404 when absent. */
  readonly get: (name: string) => Promise<Blob>;
  readonly list: () => Promise<ReadonlyArray<StoredFile>>;
  readonly delete: (name: string) => Promise<void>;
}

export type Client<Config extends AnyConfig> = {
  readonly tables: {
    readonly [Name in keyof Config["tables"]]: Config["tables"][Name] extends TableDefinition<
      infer Columns
    >
      ? TableClient<RowOf<Columns>, InsertOf<Columns>>
      : never;
  };
  readonly files: { readonly [Name in keyof Config["files"]]: FilesClient };
  /** Who the code is acting as: the viewer's claims, never a credential. */
  readonly me: () => Promise<Viewer>;
};

/** A refusal from the runtime, with the status it answered. */
export class PatchyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PatchyError";
  }
}

const call = async (input: string, init?: RequestInit) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    let message = `${response.status} from ${input}`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "error" in body) {
        message = String(body.error);
      }
    } catch {
      // The refusal was not JSON; the status line is the message.
    }
    throw new PatchyError(response.status, message);
  }
  return response;
};

const json = async <A>(input: string, init?: RequestInit): Promise<A> =>
  (await call(input, init)).json() as Promise<A>;

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

/**
 * Builds the client. `baseUrl` is empty by default: the same origin as the
 * page, which is where both the dev runtime's proxy and the shell live.
 */
export const createClient = <Config extends AnyConfig>(
  config: Config,
  options?: { readonly baseUrl?: string }
): Client<Config> => {
  const base = `${options?.baseUrl ?? ""}/_patchy`;
  const tables = Object.fromEntries(
    Object.keys(config.tables).map((name) => {
      const url = `${base}/tables/${name}`;
      const client: TableClient<unknown, unknown> = {
        insert: async (row) => (await json<{ row: unknown }>(`${url}/insert`, post({ row }))).row,
        list: async (options) =>
          (await json<{ rows: ReadonlyArray<unknown> }>(`${url}/list`, post(options ?? {}))).rows,
        get: async (id) => {
          try {
            return (await json<{ row: unknown }>(`${url}/${encodeURIComponent(id)}`)).row;
          } catch (error) {
            if (error instanceof PatchyError && error.status === 404) return null;
            throw error;
          }
        },
        delete: async (id) => {
          await call(`${url}/${encodeURIComponent(id)}`, { method: "DELETE" });
        }
      };
      return [name, client];
    })
  );
  const files = Object.fromEntries(
    Object.keys(config.files).map((name) => {
      const url = `${base}/files/${name}`;
      const client: FilesClient = {
        put: async (fileName, data, contentType) =>
          (
            await json<{ file: StoredFile }>(`${url}/${encodeURIComponent(fileName)}`, {
              method: "PUT",
              headers: { "content-type": contentType ?? data.type ?? "application/octet-stream" },
              body: data
            })
          ).file,
        get: async (fileName) => (await call(`${url}/${encodeURIComponent(fileName)}`)).blob(),
        list: async () => (await json<{ files: ReadonlyArray<StoredFile> }>(url)).files,
        delete: async (fileName) => {
          await call(`${url}/${encodeURIComponent(fileName)}`, { method: "DELETE" });
        }
      };
      return [name, client];
    })
  );
  return {
    tables: tables as Client<Config>["tables"],
    files: files as Client<Config>["files"],
    me: () => json<Viewer>(`${base}/me`)
  };
};

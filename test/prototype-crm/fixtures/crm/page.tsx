// PROTOTYPE for #315: the consumer's page. It renders the live pipeline and the shared contracts
// (thumbnails through useFileUrl) and exposes window.harness for the proofs to drive.
import { createServerOnlyClient, type FileHandle, type Upload } from "patchy/client";
// The same transport the generated client builds; not a public entry, imported for the harness.
import { createPostMessageTransport } from "../../../../packages/patchy/src/clientTransport";
import { render, useFileUrl, useQuery, useEffect } from "patchy/preact";

type Deal = { id: string; title: string; stage: string; private: boolean; mine: boolean };
type File = { name: string; size: number; contentType: string; handle: FileHandle };
type Query<A, T> = ((args: A) => Promise<T>) & {
  subscribe(args: A, next: (value: T) => void, options?: object): () => void;
};
// The harness keeps the transport so a redemption's bytes can be measured (the frame's CSP has
// connect-src 'none', so a blob URL cannot be fetched back); it is the same broker path url() uses.
const transport = createPostMessageTransport();
const client = createServerOnlyClient(
  {},
  { transport, serverModules: ["attachments", "contracts", "deals"] }
);
const server = client.server as unknown as {
  deals: {
    pipeline: Query<object, Deal[]>;
    create(args: { title: string; stage: string; private: boolean }): Promise<string>;
  };
  contracts: { list: Query<object, File[]> };
  attachments: {
    list: Query<{ dealId: string }, File[]>;
    stored(args: { dealId: string; name: string }): Promise<File | null>;
    attach(args: { dealId: string; name: string; file: Upload; fail: boolean }): Promise<{
      stored: File;
      recorded: boolean;
      reason: string | null;
      measured: number;
      claimed: string;
    }>;
  };
};

const state: Record<string, unknown> = {};
const stamp = (key: string, value: unknown) => {
  state[key] = { ...(value as object), at: performance.now() };
};

function Thumb({ file }: { file: File }) {
  const { url, error } = useFileUrl(file.handle);
  useEffect(() => {
    stamp(`thumb:${file.name}`, { handle: file.handle, url, error: error?.code });
  }, [file.handle, url, error]);
  return (
    <li data-name={file.name}>
      {file.name} {error ? <b class="error">{error.code}</b> : null}
      {url ? <img alt={file.name} src={url} width={40} /> : null}
    </li>
  );
}

function App() {
  const pipeline = useQuery(server.deals.pipeline, {});
  const contracts = useQuery(server.contracts.list, {});
  useEffect(() => {
    stamp("pipeline", {
      data: pipeline.data,
      error: pipeline.error
        ? ((pipeline.error as { code?: string }).code ?? pipeline.error.message)
        : undefined,
      status: pipeline.status
    });
  }, [pipeline.data, pipeline.error, pipeline.status]);
  useEffect(() => {
    stamp("contracts", {
      data: contracts.data,
      error: contracts.error
        ? ((contracts.error as { code?: string }).code ?? contracts.error.message)
        : undefined,
      status: contracts.status
    });
  }, [contracts.data, contracts.error, contracts.status]);
  return (
    <main>
      <h1 id="identity">CRM fixture</h1>
      <p id="pipeline-status">{pipeline.status}</p>
      <ul id="deals">
        {(pipeline.data ?? []).map((deal) => (
          <li key={deal.id} data-deal={deal.id}>
            {deal.title} · {deal.stage}
            {deal.private ? " · private" : ""}
          </li>
        ))}
      </ul>
      <p id="contracts-error">
        {contracts.error ? (contracts.error as { code?: string }).code : ""}
      </p>
      <ul id="contracts">
        {contracts.error
          ? null
          : (contracts.data ?? []).map((file) => <Thumb key={file.name} file={file} />)}
      </ul>
    </main>
  );
}

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
(window as unknown as { harness: unknown }).harness = {
  ready: true,
  state,
  me: () => client.me(),
  create: (title: string, stage: string, isPrivate: boolean) =>
    server.deals.create({ title, stage, private: isPrivate }),
  pipeline: () => server.deals.pipeline({}),
  contracts: () => server.contracts.list({}),
  attachments: (dealId: string) => server.attachments.list({ dealId }),
  stored: (dealId: string, name: string) => server.attachments.stored({ dealId, name }),
  async attach(dealId: string, name: string, base64: string, contentType: string, fail: boolean) {
    const file = await client.files.stage(decode(base64), { contentType });
    try {
      return {
        ok: true,
        value: await server.attachments.attach({ dealId, name, file, fail }),
        file
      };
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code, file };
    }
  },
  /** One redemption through this document's shell, timed. */
  async redeem(handle: FileHandle) {
    const started = performance.now();
    try {
      const reply = (await transport.call("files.redeem", { handle })) as {
        bytes: Uint8Array;
        name: string;
      };
      return {
        ok: true,
        size: reply.bytes.byteLength,
        name: reply.name,
        ms: performance.now() - started
      };
    } catch (error) {
      return {
        ok: false,
        code: (error as { code?: string }).code ?? String(error),
        ms: performance.now() - started
      };
    }
  },
  stage: (base64: string, contentType: string) =>
    client.files.stage(decode(base64), { contentType }),
  /** Any broker operation, as a page could send it. */
  async raw(op: string, args: unknown) {
    try {
      return { ok: true, value: await transport.call(op as never, args) };
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code };
    }
  },
  async actionWith(upload: Upload) {
    try {
      return {
        ok: true,
        value: await server.attachments.attach({
          dealId: "none",
          name: "x",
          file: upload,
          fail: false
        })
      };
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code };
    }
  }
};
render(<App />, document.getElementById("root")!);

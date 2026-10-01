import { createServer, type RequestListener, type Server } from "node:http";
import { buffer } from "node:stream/consumers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as S3ContentStore from "../src/S3ContentStore.js";

const bucket = "contract";
const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Only the four path-style operations the adapter uses; no signing or general S3 emulation. */
function objectRequests(): RequestListener {
  const objects = new Map<string, { body: Buffer; modified: string }>();
  return (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const fail = (status: number, code: string) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    };
    if (url.pathname !== `/${bucket}` && !url.pathname.startsWith(`/${bucket}/`)) {
      fail(404, "NoSuchBucket");
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
    if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const token = url.searchParams.get("continuation-token");
      const after = token === null ? "" : Buffer.from(token, "base64url").toString("utf8");
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && key > after)
        .sort();
      const page = keys.slice(0, 1000);
      const truncated = keys.length > page.length;
      const next = truncated
        ? `<NextContinuationToken>${Buffer.from(page[999]!).toString("base64url")}</NextContinuationToken>`
        : "";
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${next}${page
          .map(
            (key) =>
              `<Contents><Key>${xml(key)}</Key><LastModified>${objects.get(key)!.modified}</LastModified></Contents>`
          )
          .join("")}</ListBucketResult>`
      );
    } else if (key !== "" && request.method === "PUT") {
      void buffer(request).then(
        (body) => {
          objects.set(key, { body, modified: new Date().toISOString() });
          response.writeHead(200);
          response.end();
        },
        () => response.destroy()
      );
    } else if (key !== "" && request.method === "GET") {
      const object = objects.get(key);
      if (object === undefined) {
        fail(404, "NoSuchKey");
      } else {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(object.body);
      }
    } else if (key !== "" && request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
    } else {
      fail(501, "NotImplemented");
    }
  };
}

/** Each scope owns its map, loopback listener, and real SDK client; a handler can inject wire failures. */
export const makeTestStore = (respond?: RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<Server>((resolve, reject) => {
            const server = createServer(respond ?? objectRequests());
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          })
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            })
        )
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an isolated TCP listener");
    }
    return yield* S3ContentStore.make.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PATCHY_S3_BUCKET: bucket,
            PATCHY_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
            PATCHY_S3_REGION: "us-east-1",
            PATCHY_S3_ACCESS_KEY_ID: "test-access-key",
            PATCHY_S3_SECRET_ACCESS_KEY: "test-secret-key"
          })
        )
      )
    );
  });

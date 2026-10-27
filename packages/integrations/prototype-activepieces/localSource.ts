import { createServer } from "node:http";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Source from "../src/posthog/Source.js";
import { customers } from "./customers.js";
import { makeSource } from "./posthog.js";

/** Only a loopback simulator is available to this local entrypoint. No real provider mode. */
export const make = Effect.gen(function* () {
  const provider = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const server = createServer(async (request, response) => {
          const customer = customers.find(
            (item) => request.headers.authorization === `Bearer ${item.key}`
          );
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          const send = (status: number, body: unknown) =>
            response.writeHead(status).end(JSON.stringify(body));
          if (!customer) {
            send(401, { detail: "Only the supplied dummy keys are accepted by the simulator." });
            return;
          }
          const path = new URL(request.url!, "http://localhost").pathname;
          if (!path.startsWith(`/api/projects/${customer.projectId}/`)) {
            send(403, { detail: "Wrong mock project for this key." });
            return;
          }
          if (
            request.method === "GET" &&
            /\/(event_definitions|property_definitions)\/$/.test(path)
          ) {
            send(200, { results: [], next: null });
            return;
          }
          if (request.method !== "POST" || !path.endsWith("/query/")) {
            send(404, {});
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 128_000) {
              send(413, {});
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              query?: { query?: string };
            };
            const query = body.query?.query;
            if (query === "SELECT 1") {
              send(200, {
                columns: ["1"],
                types: [["1", "UInt8"]],
                results: [[1]],
                hasMore: false
              });
              return;
            }
            if (query !== "SELECT project_id, company, events FROM prototype_usage LIMIT 1") {
              send(400, { detail: "The simulator supports only the demo query." });
              return;
            }
            send(200, {
              columns: ["project_id", "company", "events"],
              types: [
                ["project_id", "UInt64"],
                ["company", "String"],
                ["events", "UInt64"]
              ],
              results: [[customer.projectId, customer.name, customer.events]],
              hasMore: false
            });
          } catch {
            send(400, {});
          }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Mock listener unavailable");
        return { server, url: `http://127.0.0.1:${address.port}` };
      },
      catch: (cause) => new Source.Unavailable({ stage: "request", cause: Redacted.make(cause) })
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
  );
  const http = yield* HttpClient.HttpClient;
  // Native admin validation/discovery stays real, but every request is redirected in-process
  // to the same loopback simulator. The Activepieces action uses that simulator directly.
  const native = yield* Source.make.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequest(http, (request) => {
        const url = new URL(request.url);
        return HttpClientRequest.setUrl(request, `${provider.url}${url.pathname}${url.search}`);
      })
    )
  );
  return yield* makeSource(() => provider.url).pipe(Effect.provideService(Source.Source, native));
});

export const layer = Layer.effect(Source.Source, make).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * The whole server for its tests: over a fresh migrated database and an
 * ephemeral port, configured as the test spells it. `HttpClient` points at
 * the socket, `SqlClient` at the database, and `TestClock` — which
 * `it.layer` brings — reaches every fiber the server forks.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { clerkEnv } from "@patchy/auth/testing";
import * as Testing from "@patchy/sql/testing";
import * as Server from "../Server.js";

export const server = (env: Record<string, string | undefined> = {}) =>
  Server.layer.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Testing.layer()),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...clerkEnv(),
          PATCHY_STORAGE_DIR: mkdtempSync(path.join(os.tmpdir(), "patchy-server-")),
          PATCHY_PUBLIC_BASE_URL: "https://patchy.example",
          ...env
        })
      )
    )
  );

/** One request to the server, as the socket sees it. */
export const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request));

/** The status and decoded JSON body, for a response the test compares whole. */
export const answer = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(response.json, (body) => ({ status: response.status, body }));

export const html = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

export const upload = (token: string, body: unknown) =>
  send(
    HttpClientRequest.post("/api/uploads").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  );

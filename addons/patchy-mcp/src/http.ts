import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type ErrorRequestHandler } from "express";
import { createServer } from "./index.js";
import { normalizeUrl } from "./api.js";
import { createOAuth } from "./oauth.js";
import { homedir } from "node:os";
import path from "node:path";
import { version } from "./version.js";

export function createHttpApp(
  origin: string,
  apiUrl: string,
  options: { stateDir?: string } = {},
) {
  const selected = normalizeUrl(apiUrl);
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "This local HTTP entry point requires a loopback HTTP origin.",
    );
  const app = createMcpExpressApp({ host: url.hostname, jsonLimit: "1mb" });
  // Only origins admitted by the SDK's loopback guard reach this middleware.
  app.use((req, res, next) => {
    if (req.headers.origin)
      res.set({
        "Access-Control-Allow-Origin": req.headers.origin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, content-type, mcp-protocol-version, mcp-session-id",
        "Access-Control-Expose-Headers":
          "www-authenticate, mcp-protocol-version, mcp-session-id",
        Vary: "Origin",
      });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  const oauth = createOAuth(origin, selected, options.stateDir);
  app.get("/healthz", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json({
        ok: true,
        version,
        instanceUrl: selected,
        mcpUrl: oauth.resource.href,
      }),
  );
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: oauth.metadata,
      resourceServerUrl: oauth.resource,
      scopesSupported: oauth.scopes,
    }),
  );
  app.use("/oauth", oauth.router);
  const handler = createMcpHandler((ctx) =>
    createServer(oauth.requestFor(ctx.authInfo), "launch-queue", () =>
      oauth.requestFor(ctx.authInfo, true),
    ),
  );
  const node = toNodeHandler(handler);
  app.all(
    "/mcp",
    requireBearerAuth({
      verifier: oauth.verifier,
      expectedResource: oauth.resource,
      requiredScopes: [oauth.scope],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauth.resource),
    }),
    (req, res) => node(req, res, req.body),
  );
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const code =
      typeof error?.code === "string" && error.name === "OAuthError"
        ? error.code
        : "server_error";
    const basicFailure =
      code === "invalid_client" &&
      req.headers.authorization?.startsWith("Basic ");
    if (basicFailure) res.set("WWW-Authenticate", 'Basic realm="Patchy MCP"');
    res
      .status(
        basicFailure
          ? 401
          : code === "server_error"
            ? 500
            : code === "temporarily_unavailable"
              ? 503
              : 400,
      )
      .set("Cache-Control", "no-store")
      .json({
        error: code,
        error_description:
          code === "server_error"
            ? "The request could not be completed."
            : error.message,
      });
  };
  app.use(errors);
  return {
    app,
    close: async () => {
      await handler.close();
      oauth.close();
    },
  };
}

export async function serveHttp(
  apiUrl: string,
  port = 38143,
  stateDir = path.join(
    homedir(),
    ".local",
    "state",
    "patchy-mcp",
    String(port),
  ),
) {
  const origin = `http://127.0.0.1:${port}`;
  const { app, close } = createHttpApp(origin, apiUrl, { stateDir });
  const server = app.listen(port, "127.0.0.1", () =>
    console.error(
      `Patchy MCP ${version}: ${origin}/mcp (Cloud: ${normalizeUrl(apiUrl)}). Local only; OAuth required. State: ${stateDir}`,
    ),
  );
  server.on("error", () => {
    void close();
    console.error(
      `Could not start local MCP HTTP listener on ${port}. Check whether the port is already in use.`,
    );
    process.exitCode = 1;
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
    void close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

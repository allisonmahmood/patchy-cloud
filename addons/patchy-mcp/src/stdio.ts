import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./index.js";
import { request, credentialRequest } from "./api.js";

void serveStdio(() =>
  createServer(
    request,
    process.env.PATCHY_LAUNCH_QUEUE_PATCH?.trim() || "launch-queue",
    credentialRequest,
  ),
);

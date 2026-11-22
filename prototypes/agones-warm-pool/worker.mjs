// Synthetic lifecycle worker; deliberately contains no Patchy execution code.
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const sdk = async (path, method = "GET") => {
  const response = await fetch(`http://127.0.0.1:9358${path}`, {
    method,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Agones SDK ${path}: ${response.status}`);
  return response;
};

let ready = false;
const server = createServer(async (request, response) => {
  try {
    if (!ready) {
      response.writeHead(503).end();
      return;
    }
    const gameServer = await (await sdk("/gameserver")).json();
    const identity = {
      name: gameServer.object_meta.name,
      company: gameServer.object_meta.labels["prototype-company"] ?? null,
      state: gameServer.status.state
    };
    if (request.url === "/shutdown" && request.method === "POST") {
      // The SDK, not the test runner deleting a Pod, drives shutdown.
      await sdk("/shutdown", "POST");
    } else if (request.url !== "/identity" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(identity));
  } catch (error) {
    console.error(error);
    response.writeHead(500).end(String(error));
  }
});
server.listen(8081, "127.0.0.1");

for (let attempt = 0; ; attempt++) {
  try {
    await sdk("/ready", "POST");
    break;
  } catch (error) {
    if (attempt >= 60) throw error;
    await delay(500);
  }
}
ready = true;
const health = setInterval(() => sdk("/health", "POST").catch(console.error), 1_000);
process.on("SIGTERM", () => {
  clearInterval(health);
  server.close();
});

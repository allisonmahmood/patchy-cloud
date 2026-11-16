import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const files = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.ts", "text/javascript"]],
  ["/patchy.css", ["patchy.css", "text/css"]],
  ["/prototype.css", ["prototype.css", "text/css"]],
  ["/data.json", ["data.json", "application/json"]],
  ["/assets/geist.woff2", ["assets/geist.woff2", "font/woff2"]],
  ["/assets/cabinet-grotesk.woff2", ["assets/cabinet-grotesk.woff2", "font/woff2"]]
]);
const port = Number(process.argv[2] ?? 43159);
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = files.get(path);
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    const output =
      file[0] === "app.ts" ? stripTypeScriptTypes(body.toString(), { mode: "strip" }) : body;
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" }).end(output);
  } catch {
    response.writeHead(500).end("Could not read prototype file");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Prototype only: http://127.0.0.1:${port}`));

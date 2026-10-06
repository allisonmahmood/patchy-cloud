// THROWAWAY LOCAL PROTOTYPE: one chosen bell → expandable history interaction.
// Run: pnpm prototype:updates. No production routes, credentials, or databases.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { htmlPage } from "../../../core/src/html.ts";
import { initialState, prepareActionPayload, recordConfirmedDeployment } from "./deploy-action.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const scratch = resolve(directory, "../../../../.local/updates-prototype");
mkdirSync(scratch, { recursive: true });
const stateFile = resolve(scratch, "PROTOTYPE-state.json");
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : initialState();
function save() {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}
save();

const body = `<section class="prototype-home">
  <h1 class="page-heading">Your company’s patches</h1>
  <p class="supporting-text">The tools your team builds and uses together.</p>
  <div class="prototype-portal">
    <aside><h2 class="section-heading">Yours</h2><ul class="list list-compact">
      <li class="list-row"><button class="list-link prototype-patch" data-patch="team-handbook" aria-current="page">team-handbook<span class="supporting-text">Everything the team needs to get started</span></button></li>
      <li class="list-row"><button class="list-link prototype-patch" data-patch="weekly-report">weekly-report<span class="supporting-text">A quick look at this week’s progress</span></button></li>
    </ul><section class="section"><h2 class="section-heading">Company</h2><ul class="list list-compact">
      <li class="list-row"><button class="list-link prototype-patch" data-patch="request-tracker">request-tracker<span class="supporting-text">Keep internal requests moving</span></button></li>
    </ul></section></aside>
    <article id="prototype-patch-card"><h2 class="section-heading">team-handbook</h2><p>Everything the team needs to get started. Find useful links, working agreements, and the answers to everyday questions.</p><dl class="facts"><dt>Owner</dt><dd>Srikar</dd><dt>Who can open</dt><dd>Everyone at Patchy Dev</dd><dt>Current version</dt><dd>v3</dd></dl><section class="section"><h3 class="section-heading">About this patch</h3><p>A shared starting point for the team, kept up to date as we grow.</p><span class="pill pill-done">Live</span></section></article>
  </div>
</section>`;

function page() {
  return htmlPage({
    title: "Patchy · local updates prototype",
    app: {
      viewer: { user: { name: "Srikar" }, company: { name: "Patchy Dev" } },
      section: "patches"
    },
    body,
    head: '<link rel="stylesheet" href="/prototype.css"><script defer src="/prototype.js"></script>'
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const send = (value, type = "application/json") => {
    response.setHeader("Content-Type", `${type}; charset=utf-8`);
    response.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  if (request.method === "POST") {
    // Only the loopback prototype's own pages may drive this local simulation.
    if (request.headers.origin !== `http://${request.headers.host}`) {
      response.statusCode = 403;
      return send({ error: "Use the local simulation page." });
    }
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 16_384) {
        response.statusCode = 413;
        return send({ error: "Payload too large" });
      }
    }
    let input;
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      response.statusCode = 400;
      return send({ error: "Invalid JSON" });
    }
    if (url.pathname === "/simulation/deploy") {
      // Simulated GitHub Action: collect notes → confirm live → publish record.
      const payload = prepareActionPayload(state.entries.at(-1).sequence + 1);
      state = recordConfirmedDeployment(state, payload);
    } else if (url.pathname === "/simulation/retry") {
      const { sequence, ...latest } = state.entries.at(-1);
      state = recordConfirmedDeployment(state, { ...latest, runAttempt: latest.runAttempt + 1 });
    } else if (url.pathname === "/simulation/reset") {
      state = initialState();
    } else if (url.pathname === "/simulation/seen") {
      if (
        input.generation === state.generation &&
        Number.isInteger(input.through) &&
        state.entries.some((entry) => entry.sequence === input.through)
      ) {
        state = { ...state, readThrough: Math.max(state.readThrough, input.through) };
      }
    } else {
      response.statusCode = 404;
      return send({ error: "Unknown simulation action" });
    }
    save();
    return send(state);
  }
  if (request.method !== "GET") {
    response.statusCode = 405;
    return response.end();
  }
  if (url.pathname === "/simulation/state") return send(state);
  if (url.pathname === "/prototype.js")
    return send(readFileSync(resolve(directory, "client.js"), "utf8"), "text/javascript");
  if (url.pathname === "/prototype.css")
    return send(readFileSync(resolve(directory, "prototype.css"), "utf8"), "text/css");
  if (["/", "/updates", "/company", "/company/connections", "/machines"].includes(url.pathname))
    return send(page(), "text/html");
  response.statusCode = 404;
  send("Not found", "text/plain");
});
server.listen(Number(process.env.PATCHY_PROTOTYPE_PORT ?? 20660), "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(resolve(scratch, "plan.json"), JSON.stringify({ pid: process.pid, url }));
  console.log(
    `Local updates prototype: ${url}\nState: ${stateFile}\nCtrl-C to stop. Reset demo clears sample history and read state.`
  );
});

import { randomUUID } from "node:crypto";

const apiUrl = process.env.PATCHY_API_URL;
const apiToken = process.env.PATCHY_API_TOKEN;
if (!apiUrl || !apiToken) {
  throw new Error("PATCHY_API_URL and PATCHY_API_TOKEN must both be set to seed pages.");
}

/** Single-file pages, as `patchy publish page.html` sends them: self-contained, script allowed. */
const pages = [
  {
    filename: "project-status.html",
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Project status</title>
<style>body { max-width: 40rem; margin: 3rem auto; font-family: system-ui; } td { padding: 0.25rem 1rem 0.25rem 0; }</style>
</head>
<body>
<h1>Project status</h1>
<nav><a href="#risks">Risks</a></nav>
<table><tr><td>Design</td><td>Done</td></tr><tr><td>Build</td><td>In progress</td></tr></table>
<div style="height: 120vh"></div>
<h2 id="risks">Risks</h2>
<p>None this week.</p>
</body>
</html>
`
  },
  {
    filename: "counter.html",
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Counter</title></head>
<body>
<h1>Counter</h1>
<button type="button" id="count">Clicked 0 times</button>
<script>
  let clicks = 0;
  const button = document.getElementById("count");
  button.addEventListener("click", () => { button.textContent = \`Clicked \${++clicks} times\`; });
</script>
</body>
</html>
`
  }
];

const publishUrl = new URL("/api/publish", apiUrl);
const releaseResponse = await fetch(new URL("/api/release", apiUrl));
if (!releaseResponse.ok) throw new Error(`Could not read release: ${releaseResponse.status}`);
const { release, manifestVersion } = await releaseResponse.json();

for (const page of pages) {
  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      manifest: { manifestVersion, release, tier: 1, tables: {}, files: {}, uses: {} },
      html: page.html,
      publishKey: randomUUID(),
      metadata: { filename: page.filename }
    })
  });

  if (!response.ok) {
    throw new Error(`Could not seed ${page.filename}: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  console.log(`${page.filename}: ${result.address}`);
}

console.log(`Seeded ${pages.length} single-file pages.`);

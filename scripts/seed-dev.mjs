import { randomUUID } from "node:crypto";
import { readFixtureCorpus } from "../test/html-fixtures.mjs";

const apiUrl = process.env.PATCHY_API_URL;
const apiToken = process.env.PATCHY_API_TOKEN;
if (!apiUrl || !apiToken) {
  throw new Error("PATCHY_API_URL and PATCHY_API_TOKEN must both be set to seed HTML fixtures.");
}
const publishUrl = new URL("/api/publish", apiUrl);
const fixtures = await readFixtureCorpus("accept");
const releaseResponse = await fetch(new URL("/api/release", apiUrl));
if (!releaseResponse.ok) throw new Error(`Could not read release: ${releaseResponse.status}`);
const { release, manifestVersion } = await releaseResponse.json();

for (const fixture of fixtures) {
  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      manifest: { manifestVersion, release, tier: 0, tables: {}, files: {}, uses: {} },
      html: fixture.html,
      publishKey: randomUUID(),
      metadata: { filename: fixture.filename }
    })
  });

  if (!response.ok) {
    throw new Error(
      `Could not seed ${fixture.filename}: ${response.status} ${await response.text()}`
    );
  }

  const result = await response.json();
  console.log(`${fixture.filename}: ${result.address}`);
}

console.log(`Seeded ${fixtures.length} HTML fixtures from packages/core/fixtures/accept/.`);

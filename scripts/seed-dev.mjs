import { readFixtureCorpus } from "../test/html-fixtures.mjs";

const apiUrl = process.env.PATCHY_API_URL;
const apiToken = process.env.PATCHY_API_TOKEN;
if (!apiUrl || !apiToken) {
  throw new Error("PATCHY_API_URL and PATCHY_API_TOKEN must both be set to seed HTML fixtures.");
}
const uploadUrl = new URL("/api/uploads", apiUrl);
const fixtures = await readFixtureCorpus("accept");

for (const fixture of fixtures) {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ filename: fixture.filename, html: fixture.html })
  });

  if (!response.ok) {
    throw new Error(
      `Could not seed ${fixture.filename}: ${response.status} ${await response.text()}`
    );
  }

  const result = await response.json();
  console.log(`${fixture.filename}: ${result.publicUrl}`);
}

console.log(`Seeded ${fixtures.length} HTML fixtures from packages/core/fixtures/accept/.`);

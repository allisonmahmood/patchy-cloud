/**
 * THROWAWAY (prototype #241): seed a running dev instance with colleagues,
 * a dozen internal tools with descriptions, two shared-table dependants, a
 * deactivated owner, one retired and one deleted patch. Run once per fresh
 * instance after `pnpm dev`; a second run refuses.
 *
 *   pnpm dev && pnpm proto:seed
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const envFile = new URL("../.local/dev/env", import.meta.url);
const env = { ...process.env };
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && env[match[1]] === undefined) env[match[1]] = match[2];
  }
} catch {
  // Fall through to the process environment.
}
const { PATCHY_API_URL: apiUrl, PATCHY_API_TOKEN: token, DATABASE_URL: databaseUrl } = env;
if (!apiUrl || !token || !databaseUrl) {
  throw new Error("Need PATCHY_API_URL, PATCHY_API_TOKEN and DATABASE_URL: run pnpm dev first.");
}

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const company = "cmp_dev";
const dev = "usr_dev";

const already = await db.query(
  "SELECT 1 FROM patches WHERE company_id = $1 AND name = 'lunch-orders'",
  [company]
);
if (already.rowCount > 0) {
  console.error(
    "Already seeded: lunch-orders exists in Patchy Dev. Use pnpm dev reset for a fresh instance."
  );
  await db.end();
  process.exit(1);
}

// 1. Colleagues.
const users = {
  sam: {
    id: "usr_proto_sam",
    clerk: "user_proto_sam",
    name: "Sam Okafor",
    email: "sam+clerk_test@patchy.local",
    role: "member"
  },
  priya: {
    id: "usr_proto_priya",
    clerk: "user_proto_priya",
    name: "Priya Natarajan",
    email: "priya+clerk_test@patchy.local",
    role: "admin"
  },
  jonas: {
    id: "usr_proto_jonas",
    clerk: "user_proto_jonas",
    name: "Jonas Weber",
    email: "jonas+clerk_test@patchy.local",
    role: "member"
  }
};
for (const user of Object.values(users)) {
  await db.query(
    `INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '120 days')
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.clerk, company, user.email, user.name, user.role]
  );
}
await db.query("UPDATE users SET deactivated_at = now() - interval '14 days' WHERE id = $1", [
  users.jonas.id
]);

// 2. Publish through the API as Dev Machine.
const releaseResponse = await fetch(new URL("/api/release", apiUrl));
if (!releaseResponse.ok) throw new Error(`Could not read release: ${releaseResponse.status}`);
const { release, manifestVersion } = await releaseResponse.json();

const page = (title, heading, body) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { max-width: 44rem; margin: 3rem auto; font-family: system-ui; color: #18202a; line-height: 1.5; }
      table { border-collapse: collapse; width: 100%; }
      td, th { padding: .4rem .6rem; border-bottom: 1px solid #ccd5df; text-align: left; }
    </style>
  </head>
  <body>
    <h1>${heading}</h1>
    ${body}
  </body>
</html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One publish; a 429 (ten creates per machine per minute) waits it out and resends the same key. */
const publish = async (name, html, manifest = {}, patchId = undefined) => {
  const publishKey = randomUUID();
  for (;;) {
    const response = await fetch(new URL("/api/publish", apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          manifestVersion,
          release,
          name,
          tier: 0,
          tables: {},
          files: {},
          uses: {},
          ...manifest
        },
        html,
        ...(patchId === undefined ? {} : { patchId }),
        publishKey,
        metadata: {}
      })
    });
    const body = await response.json();
    if (response.status === 429) {
      const seconds = body.retryAfterSeconds ?? 60;
      console.log(`  rate limited; waiting ${seconds}s before ${name}`);
      await sleep(seconds * 1000 + 500);
      continue;
    }
    if (!response.ok)
      throw new Error(`Could not publish ${name}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
};

const tools = {
  "lunch-orders": {
    title: "Lunch orders",
    description:
      "Thursday lunch orders for the office. Everyone adds what they want by Wednesday noon; whoever is on kitchen duty places the order and marks it collected. The orders table is shared so the office map and the expense form can read it.",
    manifest: {
      tier: 1,
      tables: {
        orders: {
          columns: {
            item: { kind: "text" },
            quantity: { kind: "integer", default: 1 },
            person: { kind: "text" },
            note: { kind: "text", optional: true },
            collected: { kind: "boolean", default: false }
          },
          indexes: {
            byPerson: { columns: ["person"] },
            byItem: { columns: ["item", "person"], unique: true }
          },
          shared: true
        }
      }
    }
  },
  "office-map": {
    title: "Office map",
    description:
      "Where everyone sits, by floor and desk number; searchable by name. Updated each quarter after the desk shuffle. Reads the lunch orders so a desk shows who has ordered.",
    usesOrders: true,
    manifest: { tier: 1 }
  },
  "sales-dashboard": {
    title: "Vite",
    description:
      "Weekly pipeline and closed-won by rep, pasted in from the CRM export every Monday morning. Sales managers open this before the 10am stand-up; the numbers are a week old by Friday, on purpose.",
    scope: "public"
  },
  "onboarding-checklist": {
    title: "Onboarding checklist",
    description:
      "A new hire's first two weeks: accounts to request, people to meet, policies to read and the buddy's name. Managers copy the page per hire and tick it off together."
  },
  "vendor-list": {
    title: "Vendor list",
    description:
      "Every supplier we buy from, with the contract owner and the renewal month; check here before opening a new account with someone."
  },
  "expense-form": {
    title: "Expense form",
    description:
      "Submit a claim with the receipt attached and pick who approves it. Finance exports the month as CSV for the accountant. Lunch orders can be claimed straight from the shared table.",
    usesOrders: true,
    manifest: {
      tier: 1,
      tables: {
        claims: {
          columns: {
            amount: { kind: "number" },
            currency: { kind: "text", default: "EUR" },
            purpose: { kind: "text" },
            approver: { kind: "text" },
            approved: { kind: "boolean", default: false }
          },
          indexes: { byApprover: { columns: ["approver", "approved"] } }
        }
      },
      files: { receipts: {} }
    }
  },
  "incident-log": {
    title: "Incident log",
    description:
      "One row per production incident: when it started, who was paged, what we did and the follow-ups. The review meeting walks the last fortnight from here."
  },
  "release-calendar": {
    title: "Release calendar",
    description:
      "Planned release dates per team, the freeze weeks and who is release captain; the support desk reads it to know what changed on a given day."
  },
  "headcount-plan": {
    title: "Headcount plan",
    description:
      "Open roles by team and quarter with the hiring manager and status. Finance and the leads keep it current in the Monday planning call."
  },
  "qa-signoff": { title: "QA sign-off sheet", description: "" },
  "contracts-index": {
    title: "Contracts index",
    description:
      "Where each signed contract lives, who owns the relationship and when it ends; the index, not the documents."
  },
  "meeting-rooms": {
    title: "Meeting room board",
    description:
      "Which rooms are free right now and for how long, refreshed from the calendar; the tablet by the lifts shows this page."
  }
};

const published = {};
const lunch = await publish(
  "lunch-orders",
  page("Lunch orders", "Lunch orders", "<p>Thursday orders; add yours by Wednesday noon.</p>"),
  tools["lunch-orders"].manifest
);
published["lunch-orders"] = lunch;
console.log(`lunch-orders: ${lunch.address} (schema revision ${lunch.schemaRevision})`);
const ordersUse = {
  orders: {
    kind: "sharedTable",
    patchId: lunch.patchId,
    table: "orders",
    id: `${lunch.patchId}/orders`,
    revision: lunch.schemaRevision
  }
};
for (const [name, tool] of Object.entries(tools)) {
  if (name === "lunch-orders") continue;
  const manifest = { ...(tool.manifest ?? {}), ...(tool.usesOrders ? { uses: ordersUse } : {}) };
  const body = tool.description
    ? `<p>${tool.description.split(". ")[0]}.</p>`
    : "<p>Tick each check before the release goes out.</p>";
  const result = await publish(name, page(tool.title, tool.title, body), manifest);
  if (tool.scope) {
    await fetch(new URL(`/api/patches/${result.patchId}/share`, apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: tool.scope })
    });
  }
  published[name] = result;
  console.log(`${name}: ${result.address}`);
}

// Publish a few more versions so the versions table has something to roll back to.
for (const name of ["lunch-orders", "sales-dashboard", "office-map"]) {
  const versions = name === "sales-dashboard" ? 5 : 2;
  for (let n = 0; n < versions; n++) {
    const tool = tools[name];
    const manifest = { ...(tool.manifest ?? {}), ...(tool.usesOrders ? { uses: ordersUse } : {}) };
    await publish(
      name,
      page(
        tool.title,
        tool.title,
        `<p>${tool.description.split(". ")[0]}.</p><p>Revision ${n + 2}.</p>`
      ),
      manifest,
      published[name].patchId
    );
  }
}

// 3. By SQL: descriptions, owners, states, actors.
for (const [name, tool] of Object.entries(tools)) {
  await db.query("UPDATE patches SET description = $1 WHERE id = $2", [
    tool.description,
    published[name].patchId
  ]);
}
const own = async (owner, ...names) => {
  for (const name of names)
    await db.query("UPDATE patches SET owner_user_id = $1 WHERE id = $2", [
      owner,
      published[name].patchId
    ]);
};
await own(users.sam.id, "office-map", "sales-dashboard", "onboarding-checklist", "vendor-list");
await own(users.priya.id, "expense-form", "incident-log");
await own(users.jonas.id, "release-calendar", "headcount-plan");
await db.query(
  "UPDATE patches SET retired_at = now() - interval '3 days', retired_by = $1, updated_at = now() WHERE id = $2",
  [users.priya.id, published["vendor-list"].patchId]
);
await db.query(
  "UPDATE patches SET deleted_at = now() - interval '12 days', deleted_by = $1, updated_at = now() WHERE id = $2",
  [dev, published["contracts-index"].patchId]
);
await db.query(
  "UPDATE patches SET description_updated_by = $1, description_updated_at = now() - interval '5 days' WHERE id = $2",
  [users.sam.id, published["office-map"].patchId]
);
await db.query(
  "UPDATE patches SET description_updated_by = $1, description_updated_at = now() - interval '1 day' WHERE id = $2",
  [users.priya.id, published["incident-log"].patchId]
);
await db.end();

// 4. Summary.
console.log("");
console.log(
  "Owners: Patchy Dev (admin, you): lunch-orders, qa-signoff, contracts-index (deleted, 18 days left), meeting-rooms"
);
console.log(
  "        Sam Okafor (member): office-map, sales-dashboard, onboarding-checklist, vendor-list (retired by Priya)"
);
console.log("        Priya Natarajan (admin): expense-form, incident-log");
console.log("        Jonas Weber (member, deactivated): release-calendar, headcount-plan");
console.log("States: live x10, retired x1 (vendor-list), deleted x1 (contracts-index)");
console.log("Dependants: office-map and expense-form read lunch-orders/orders");
console.log(`Open ${apiUrl}/ in a browser signed in to Patchy Dev.`);

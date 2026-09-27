// PROTOTYPE for #315: the journey fixtures and the harness Fable runs the fresh agents with.
//
//   pnpm prototype:crm setup                  offline Clerk keys for this worktree's instance
//   pnpm prototype:crm-fixtures               contracts source, finance connection, contacts.csv, truth
//   pnpm prototype:crm replace <company>      the contracts owner replaces one PDF (its own action)
//   pnpm prototype:crm unshare | reshare      the contracts owner publishes with sharing off / on
//   pnpm prototype:crm reset                  reshare and restore every original document
//   pnpm prototype:crm init <dir> --variant a|b
//   pnpm prototype:crm browser owner|colleague <url>...   one signed-in window, a tab per URL
//   pnpm prototype:crm finance                (re)build the Neon finance database only
//
// Everything lives under .local/prototype-crm/ (gitignored). The instance runs with offline
// Clerk keys so this script can sign owner and colleague sessions; nothing reaches Clerk.
import { execFileSync, spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign
} from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { COMPANIES, contactsCsv, contractFiles, finance, slug } from "./seed.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const state = path.join(root, ".local/prototype-crm");
const keyFile = path.join(state, "session-key.pem");
const xdg = path.join(state, "xdg");
const contractsRepo = path.join(state, "contracts");
const contractsState = path.join(state, "contracts.json");
const cliState = path.join(state, "cli-state");
const outDir = path.join(state, "fixtures");
const truthDir = path.join(state, "truth");
const financeEnv = path.join(state, "finance.env");
const FRONTEND_API_HOST = "clerk.patchy.invalid";
const FINANCE_HANDLE = "finance";
const FINANCE_DATABASE = "crm_finance";
const FINANCE_ROLE = "crm_finance_reader";

const say = (line: string) => console.log(line);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const dotenv = (file: string) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1).replace(/^(['"])(.*)\1$/s, "$2")
      ])
  );

// --- the instance ---------------------------------------------------------------------------

function setup() {
  mkdirSync(state, { recursive: true });
  if (!existsSync(keyFile)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const publicPem = createPublicKey(createPrivateKey(readFileSync(keyFile)))
    .export({ type: "spki", format: "pem" })
    .toString();
  const publishable = `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64").replace(/=+$/, "")}`;
  mkdirSync(path.join(xdg, "patchy-cloud"), { recursive: true });
  writeFileSync(
    path.join(xdg, "patchy-cloud/dev.env"),
    `CLERK_PUBLISHABLE_KEY=${publishable}\nCLERK_SECRET_KEY=sk_test_offline\nCLERK_JWT_KEY="${publicPem.trim()}"\n`,
    { mode: 0o600 }
  );
  say(`Offline Clerk settings in ${path.relative(root, xdg)}/patchy-cloud/dev.env.`);
  say("Start the instance with:");
  say(
    `  XDG_CONFIG_HOME=${xdg} PATCHY_RUNTIME_CALLS_PER_MINUTE=100000 PATCHY_PROTOTYPE_HIDDEN_GRACE_MS=30000 pnpm dev`
  );
}

function instance() {
  const file = path.join(root, ".local/dev/env");
  if (!existsSync(file)) fail("No dev instance: run `pnpm prototype:crm setup`, then start it.");
  const env = dotenv(file);
  return {
    apiUrl: env.PATCHY_API_URL!,
    token: env.PATCHY_API_TOKEN!,
    databaseUrl: env.DATABASE_URL!
  };
}

const USERS = {
  owner: { sub: "user_dev", id: "usr_dev", email: "dev@patchy.local", name: "Patchy Dev" },
  colleague: {
    sub: "user_colleague",
    id: "usr_colleague",
    email: "colleague@patchy.local",
    name: "Colleague"
  }
} as const;
type User = keyof typeof USERS;

/** An offline session cookie, signed with the key the instance's CLERK_JWT_KEY verifies. */
function cookie(user: User, origin: string) {
  if (!existsSync(keyFile)) fail("Run `pnpm prototype:crm setup` first.");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: USERS[user].sub,
    email: USERS[user].email,
    name: USERS[user].name,
    sid: `sess_${user}`,
    iat: now - 60,
    nbf: now - 60,
    exp: now + 8 * 3600,
    iss: `https://${FRONTEND_API_HOST}`,
    azp: origin
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "patchy-offline" })
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    readFileSync(keyFile)
  ).toString("base64url");
  const jwt = `${header}.${payload}.${signature}`;
  return {
    jwt,
    header: `__session=${jwt}; __client_uat=${claims.iat}; __clerk_db_jwt=offline-browser`
  };
}

async function ensureColleague(databaseUrl: string) {
  const platform = new Client({ connectionString: databaseUrl });
  await platform.connect();
  try {
    await platform.query(
      `INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
       VALUES ('usr_colleague', 'user_colleague', 'cmp_dev', 'colleague@patchy.local', 'Colleague', 'member')
       ON CONFLICT DO NOTHING`
    );
  } finally {
    await platform.end();
  }
}

/** The worktree's CLI from source, with an isolated state dir so ~/.patchy is never touched. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      "--conditions=development",
      path.join(root, "packages/patchy/src/index.ts"),
      ...args
    ],
    { cwd, encoding: "utf8", env: { ...process.env, PATCHY_STATE_DIR: cliState, ...env } }
  );
  const out = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) fail(`patchy ${args.join(" ")} failed (exit ${result.status}):\n${out}`);
  return out;
}
const lastJson = (text: string) => {
  const start = text.lastIndexOf("\n{");
  return JSON.parse(text.slice(start === -1 ? text.indexOf("{") : start + 1)) as Record<
    string,
    unknown
  >;
};

/** One runtime call as a signed-in user, through the same admission the shell uses. */
async function runtime(
  user: User,
  op: string,
  args: unknown,
  target: { patchId: string; versionId: string } = JSON.parse(readFileSync(contractsState, "utf8"))
) {
  const { apiUrl } = instance();
  const contracts = target;
  const response = await fetch(`${apiUrl}/api/runtime/call`, {
    method: "POST",
    headers: {
      cookie: cookie(user, apiUrl).header,
      origin: apiUrl,
      "content-type": "application/json",
      "x-patchy-wire": "1",
      "x-patchy-principal": JSON.stringify({ userId: USERS[user].id })
    },
    body: JSON.stringify({
      patchId: contracts.patchId,
      versionId: contracts.versionId,
      principal: { userId: USERS[user].id },
      wire: 1,
      op,
      args
    })
  });
  const body = (await response.json()) as {
    ok: boolean;
    value?: unknown;
    code?: string;
    error?: string;
  };
  if (!body.ok) fail(`${op} refused: ${body.code} ${body.error}`);
  return body.value;
}
/** The contracts owner stages the bytes and runs the source's own `documents.replace` action. */
async function putDocument(name: string, bytes: Buffer, contentType: string) {
  const { apiUrl } = instance();
  const contracts = JSON.parse(readFileSync(contractsState, "utf8")) as {
    patchId: string;
    versionId: string;
  };
  const staged = await fetch(
    `${apiUrl}/api/runtime/uploads/${contracts.patchId}/${contracts.versionId}`,
    {
      method: "PUT",
      headers: {
        cookie: cookie("owner", apiUrl).header,
        origin: apiUrl,
        "content-type": contentType,
        "x-patchy-wire": "1",
        "x-patchy-principal": JSON.stringify({ userId: USERS.owner.id })
      },
      body: bytes
    }
  );
  const upload = (await staged.json()) as {
    ok: boolean;
    value: { token: string; size: number; contentType: string };
  };
  if (!upload.ok) fail(`staging ${name} refused: ${JSON.stringify(upload)}`);
  const reply = (await runtime("owner", "server.call", {
    handler: "documents.replace",
    args: { name, file: upload.value }
  })) as { ok: boolean; value?: { handle: string }; code?: string };
  if (!reply.ok) fail(`documents.replace ${name}: ${reply.code}`);
}

// --- the contracts source -------------------------------------------------------------------

const contractsConfig = (shared: boolean) => `import { defineConfig, files } from "patchy/config";

export default defineConfig({
  name: "contracts",
  tier: 2,
  tables: {},
  files: {
    documents: files(
      "Signed customer contracts, two files per customer company: <company-slug>.pdf is the signed master services agreement and <company-slug>.png its first-page thumbnail. The slug is the company name in lower case with hyphens, for example acme-robotics.pdf for Acme Robotics.",
      { shared: ${shared} }
    )
  },
  uses: {}
});
`;
const documentsServer = `import { query, action, t, HandlerError } from "../patchy/_generated/server.js";

const entry = t.object({ name: t.text(), size: t.number(), contentType: t.text(), updatedAt: t.text(), handle: t.fileHandle() });

/** Every document, by name. */
export const list = query({
  args: t.object({}),
  result: t.array(entry),
  handler: async (ctx) => (await ctx.files.documents.list({ limit: 1000 })).files
});

/** Adds or replaces one document from a staged upload; PDFs and PNGs only. */
export const replace = action({
  args: t.object({ name: t.text(), file: t.upload() }),
  result: entry,
  errors: ["too_large", "not_a_document"],
  handler: async (ctx, { name, file }) => {
    if (file.size > 10_000_000) throw new HandlerError("too_large");
    if (!["application/pdf", "image/png"].includes(file.contentType)) throw new HandlerError("not_a_document");
    return ctx.files.documents.put(name, file);
  }
});
`;
const contractsApp = `import { useFileUrl, useQuery } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import { patchy } from "../patchy/_generated/client.js";

function Thumb({ handle }: { handle: FileHandle }) {
  const { url } = useFileUrl(handle);
  return url ? <img src={url} width={60} alt="" /> : null;
}

export function App() {
  const { data, error } = useQuery(patchy.server.documents.list, {});
  if (error) return <p role="alert">{error.message}</p>;
  return (
    <main>
      <h1>Contracts</h1>
      <ul>
        {(data ?? []).map((file) => (
          <li key={file.name}>
            {file.contentType === "image/png" ? <Thumb handle={file.handle} /> : null}{" "}
            <button type="button" onClick={() => void patchy.files.download(file.handle)}>{file.name}</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;

function publishContracts(force = false) {
  // The release URL is content-addressed: a rebuilt instance means a new pin first.
  cli(contractsRepo, ["refresh", "--json"]);
  const out = cli(contractsRepo, ["publish", "--json", ...(force ? ["--force"] : [])]);
  const result = lastJson(out);
  writeFileSync(
    contractsState,
    JSON.stringify(
      {
        patchId: result.patchId,
        versionId: result.versionId,
        name: result.name,
        address: result.address
      },
      null,
      2
    )
  );
  return result;
}

async function ensureContracts() {
  if (!existsSync(path.join(contractsRepo, "patchy.json"))) {
    say("Initialising the contracts source (tier 2) with the worktree's CLI…");
    cli(root, [
      "init",
      path.relative(root, contractsRepo),
      "--tier",
      "2",
      "--purpose",
      "Company contracts: the signed agreement and a first-page thumbnail for each customer company, shared with the team.",
      "--json"
    ]);
    rmSync(path.join(contractsRepo, "server/notes.ts"));
    writeFileSync(path.join(contractsRepo, "server/documents.ts"), documentsServer);
    writeFileSync(path.join(contractsRepo, "src/App.tsx"), contractsApp);
    writeFileSync(path.join(contractsRepo, "patchy.config.ts"), contractsConfig(true));
    cli(contractsRepo, ["refresh", "--json"]);
    execFileSync("pnpm", ["exec", "tsc", "--noEmit"], { cwd: contractsRepo, stdio: "inherit" });
  }
  if (!existsSync(contractsState)) publishContracts();
  const contracts = JSON.parse(readFileSync(contractsState, "utf8")) as Record<string, string>;
  say(`Contracts source: ${contracts.name} (${contracts.patchId}) at ${contracts.address}`);
  return contracts;
}
async function uploadDocuments(revision = 1, only?: string) {
  for (const file of contractFiles(revision)) {
    if (only !== undefined && !file.name.startsWith(`${only}.`)) continue;
    await putDocument(file.name, file.bytes, file.contentType);
    say(`  ${file.name} (${file.bytes.byteLength} bytes)`);
  }
}
function setSharing(shared: boolean) {
  writeFileSync(path.join(contractsRepo, "patchy.config.ts"), contractsConfig(shared));
  const result = publishContracts(!shared);
  say(
    `Published contracts v${result.versionNumber} with documents ${shared ? "shared" : "unshared"}; schema revision ${result.schemaRevision}.`
  );
  for (const warning of (result.warnings as string[] | undefined) ?? [])
    say(`  warning: ${warning}`);
}

// --- finance on the Neon spike project ------------------------------------------------------

async function financeSetup() {
  const spike = path.join(process.env.HOME ?? "", ".config/patchy-cloud/neon-spike.env");
  if (!existsSync(spike)) fail(`Missing ${spike}.`);
  const admin = new URL(dotenv(spike).DATABASE_URL!);
  // Only the named database and role on the spike project; nothing else is touched.
  const password = existsSync(financeEnv)
    ? dotenv(financeEnv).FINANCE_READER_PASSWORD!
    : randomBytes(18).toString("base64url");
  const adminClient = async (database: string) => {
    const url = new URL(admin);
    url.pathname = `/${database}`;
    url.search = "?sslmode=verify-full";
    const client = new Client({ connectionString: url.href });
    await client.connect();
    return client;
  };
  const server = await adminClient(admin.pathname.slice(1));
  try {
    const exists = await server.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      FINANCE_DATABASE
    ]);
    if (exists.rowCount === 0) await server.query(`CREATE DATABASE ${FINANCE_DATABASE}`);
    const role = await server.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [FINANCE_ROLE]);
    // Neon refuses naming the SUPERUSER attribute on ALTER; a re-run only resets login and password.
    await server.query(
      role.rowCount === 0
        ? `CREATE ROLE ${FINANCE_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`
        : `ALTER ROLE ${FINANCE_ROLE} WITH LOGIN PASSWORD '${password}'`
    );
  } finally {
    await server.end();
  }
  writeFileSync(financeEnv, `FINANCE_READER_PASSWORD=${password}\n`, { mode: 0o600 });
  const { invoices, payments, truth } = finance();
  const db = await adminClient(FINANCE_DATABASE);
  try {
    await db.query("BEGIN");
    await db.query("DROP TABLE IF EXISTS payments, invoices");
    await db.query(`CREATE TABLE invoices (
      invoice_number text PRIMARY KEY,
      company_name text NOT NULL,
      issued_on date NOT NULL,
      due_on date NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents > 0)
    )`);
    await db.query(`CREATE TABLE payments (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invoice_number text NOT NULL REFERENCES invoices (invoice_number),
      paid_on date NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents > 0)
    )`);
    await db.query(
      "COMMENT ON TABLE invoices IS 'Invoices issued to customer companies; amounts in US cents.'"
    );
    await db.query(
      "COMMENT ON TABLE payments IS 'Payments received against invoices; amounts in US cents.'"
    );
    for (const invoice of invoices)
      await db.query(
        "INSERT INTO invoices (invoice_number, company_name, issued_on, due_on, amount_cents) VALUES ($1, $2, $3, $4, $5)",
        [
          invoice.invoice_number,
          invoice.company_name,
          invoice.issued_on,
          invoice.due_on,
          invoice.amount_cents
        ]
      );
    for (const payment of payments)
      await db.query(
        "INSERT INTO payments (invoice_number, paid_on, amount_cents) VALUES ($1, $2, $3)",
        [payment.invoice_number, payment.paid_on, payment.amount_cents]
      );
    await db.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${FINANCE_ROLE}`);
    await db.query(`GRANT CONNECT ON DATABASE ${FINANCE_DATABASE} TO ${FINANCE_ROLE}`);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${FINANCE_ROLE}`);
    await db.query(`GRANT SELECT ON invoices, payments TO ${FINANCE_ROLE}`);
    await db.query(`ALTER ROLE ${FINANCE_ROLE} SET default_transaction_read_only = on`);
    await db.query("COMMIT");
  } finally {
    await db.end();
  }
  const reader = new URL(admin);
  reader.username = FINANCE_ROLE;
  reader.password = password;
  reader.pathname = `/${FINANCE_DATABASE}`;
  reader.search = "?sslmode=verify-full";
  // Prove the role reads and cannot write, not merely that it is not a superuser.
  const check = new Client({ connectionString: reader.href });
  await check.connect();
  const proofs: Record<string, string> = {};
  try {
    const role = await check.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user"
    );
    proofs.role = JSON.stringify(role.rows[0]);
    proofs.read = `${(await check.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n} invoices`;
    for (const [name, sql] of [
      ["insert", "INSERT INTO invoices VALUES ('INV-X', 'X', '2026-01-01', '2026-02-01', 1)"],
      ["update", "UPDATE invoices SET amount_cents = 1"],
      ["create", "CREATE TABLE sneaky (id int)"]
    ] as const) {
      try {
        await check.query("BEGIN READ WRITE");
        await check.query(sql);
        await check.query("ROLLBACK");
        proofs[name] = "ALLOWED";
      } catch (error) {
        await check.query("ROLLBACK").catch(() => {});
        proofs[name] =
          `refused: ${(error as { code?: string; message?: string }).code} ${(error as Error).message}`;
      }
    }
  } finally {
    await check.end();
  }
  for (const [name, value] of Object.entries(proofs)) say(`  finance ${name}: ${value}`);
  if (Object.values(proofs).some((value) => value === "ALLOWED"))
    fail("The finance role can write.");
  mkdirSync(truthDir, { recursive: true });
  writeFileSync(
    path.join(truthDir, "expected-finance.json"),
    JSON.stringify(truth, null, 2) + "\n"
  );
  return reader;
}

/** Registers the connection through the admin's own connection page, as a browser would. */
async function registerFinance(reader: URL) {
  const { apiUrl, token } = instance();
  const listed = (await (
    await fetch(`${apiUrl}/api/connections`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { connections: Array<{ handle: string; status: string }> };
  if (listed.connections.some((connection) => connection.handle === FINANCE_HANDLE)) {
    say(`Connection ${FINANCE_HANDLE} already registered.`);
    return;
  }
  const response = await fetch(`${apiUrl}/company/connections/connect`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: cookie("owner", apiUrl).header,
      origin: apiUrl,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      handle: FINANCE_HANDLE,
      description:
        "Finance ledger: invoices issued to customer companies and payments received, amounts in US cents, keyed by company name.",
      credentials: reader.href
    })
  });
  if (response.status !== 303) {
    const text = await response.text();
    fail(
      `Connecting ${FINANCE_HANDLE} failed (${response.status}): ${text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 400)}`
    );
  }
  say(`Connection ${FINANCE_HANDLE} registered through /company/connections.`);
}

// --- commands -------------------------------------------------------------------------------

async function fixtures() {
  const { apiUrl, databaseUrl } = instance();
  const health = await fetch(`${apiUrl}/healthz`).catch(() => undefined);
  if (!health?.ok) fail(`The instance at ${apiUrl} is not healthy. Start it first.`);
  await ensureColleague(databaseUrl);
  const contracts = await ensureContracts();
  say("Uploading the contract documents as the contracts owner:");
  await uploadDocuments();
  say("Building the finance database on the Neon spike project:");
  const reader = await financeSetup();
  await registerFinance(reader);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(truthDir, { recursive: true });
  const { csv, truth } = contactsCsv();
  writeFileSync(path.join(outDir, "contacts.csv"), csv);
  writeFileSync(path.join(truthDir, "expected-import.json"), JSON.stringify(truth, null, 2) + "\n");
  say("");
  say(
    `contacts.csv (give to the agent): ${path.relative(root, path.join(outDir, "contacts.csv"))} — ${truth.dataRows} rows`
  );
  say(
    `Truth (never give to the agent): ${path.relative(root, truthDir)}/expected-import.json, expected-finance.json`
  );
  say(
    `Discoverable: patch "${contracts.name}" (${contracts.patchId}) store "documents"; connection "${FINANCE_HANDLE}".`
  );
  say(
    `Companies: ${COMPANIES.map((company) => `${company.name} → ${slug(company.name)}.pdf/.png`).join("; ")}`
  );
}

function init(dir: string, variant: string) {
  const { apiUrl, token } = instance();
  if (!["a", "b"].includes(variant)) fail("--variant a (patchy only) or b (wide)");
  const target = path.resolve(dir);
  // The agent's CLI state sits beside its tree, never in ~/.patchy.
  const agentState = `${target}.patchy-state`;
  const env = {
    PATCHY_API_URL: apiUrl,
    PATCHY_API_TOKEN: token,
    PATCHY_STATE_DIR: agentState,
    PATCHY_PROTOTYPE_VARIANT: variant === "b" ? "wide" : "restricted"
  };
  cli(
    path.dirname(target),
    [
      "init",
      path.basename(target),
      "--tier",
      "2",
      "--purpose",
      "A small CRM for the team: contacts, companies and deals, with a deal pipeline, attachments, company contracts and a finance report.",
      "--json"
    ],
    env
  );
  mkdirSync(path.join(target, "data"), { recursive: true });
  cpSync(path.join(outDir, "contacts.csv"), path.join(target, "data/contacts.csv"));
  execFileSync("pnpm", ["exec", "tsc", "--noEmit"], { cwd: target, stdio: "inherit" });
  say(
    `Initialised ${target} (variant ${variant.toUpperCase()}); data/contacts.csv copied; typecheck passed.`
  );
  say("Give the agent this environment (the CLI is then authenticated as Dev Machine):");
  say(`  export PATCHY_API_URL=${apiUrl} PATCHY_API_TOKEN=${token} PATCHY_STATE_DIR=${agentState}`);
}

async function browser(user: string, urls: ReadonlyArray<string>, check = false) {
  if (user !== "owner" && user !== "colleague") fail("browser owner|colleague <url>...");
  const url = urls[0] ?? fail("browser owner|colleague <url>...");
  const { chromium } = await import("@playwright/test");
  const target = new URL(url);
  const launched = await chromium.launch({ headless: check });
  const context = await launched.newContext();
  await context.route("**/*", (route) =>
    ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort("blockedbyclient")
  );
  const { header } = cookie(user as User, target.origin);
  await context.addCookies(
    header.split("; ").map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      value: pair.slice(pair.indexOf("=") + 1),
      url: target.origin,
      sameSite: "Lax" as const
    }))
  );
  const page = await context.newPage();
  const response = await page.goto(url);
  // Every further URL opens as another tab in the same signed-in window.
  for (const extra of check ? [] : urls.slice(1)) await (await context.newPage()).goto(extra);
  if (check) {
    // --check: headless, reports what the signed-in viewer's shell loaded, then exits.
    await page.waitForTimeout(3000);
    const frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
    say(
      JSON.stringify({
        status: response?.status(),
        url: page.url(),
        frame: frame !== undefined,
        text: frame === undefined ? null : (await frame.locator("body").innerText()).slice(0, 200)
      })
    );
    await launched.close();
    return;
  }
  say(`Signed in as ${USERS[user as User].email} at ${urls.join(", ")}. Close the window to end.`);
  await new Promise((resolve) => launched.on("disconnected", resolve));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "setup":
    setup();
    break;
  case "fixtures":
    await fixtures();
    break;
  case "finance":
    await registerFinance(await financeSetup());
    break;
  case "replace": {
    const company = rest[0] ?? "acme-robotics";
    await ensureContracts();
    say(`Replacing ${company}.pdf and .png with revision 2:`);
    await uploadDocuments(2, company);
    break;
  }
  case "unshare":
    await ensureContracts();
    setSharing(false);
    break;
  case "reshare":
    await ensureContracts();
    setSharing(true);
    break;
  case "reset":
    await ensureContracts();
    setSharing(true);
    say("Restoring the original documents:");
    await uploadDocuments();
    break;
  case "init": {
    const at = rest.indexOf("--variant");
    await init(
      rest[0] ?? fail("init <dir> --variant a|b"),
      at === -1 ? "a" : (rest[at + 1] ?? "a")
    );
    break;
  }
  case "call": {
    // call owner|colleague <patchId> <versionId> <module.handler> [json-args]: a handler as a viewer.
    const [user, patchId, versionId, handler, json] = rest;
    if (!user || !patchId || !versionId || !handler)
      fail("call owner|colleague <patchId> <versionId> <module.handler> [json-args]");
    const started = Date.now();
    const reply = await runtime(
      user as User,
      "server.call",
      { handler, args: JSON.parse(json ?? "{}") },
      { patchId: patchId!, versionId: versionId! }
    );
    say(JSON.stringify(reply));
    say(`(${Date.now() - started} ms)`);
    break;
  }
  case "browser":
    await browser(
      rest[0] ?? "owner",
      rest.slice(1).filter((arg) => arg !== "--check"),
      rest.includes("--check")
    );
    break;
  default:
    say(
      "Commands: setup, fixtures, finance, replace [company-slug], unshare, reshare, reset, init <dir> --variant a|b, browser owner|colleague <url>"
    );
    process.exit(command === undefined ? 0 : 1);
}
chmodSync(state, 0o700);

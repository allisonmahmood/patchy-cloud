/**
 * The feedback capability's schema, id 34 in the global migration sequence: the `feedback`
 * schema, where requests and feedback land whichever surface sent them, and the general requests
 * Patchy's team writes. Its own schema, so one read role can see these rows and nothing else
 * (`packages/feedback/read-role.sql`).
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0034_feedback": ddl(
    `CREATE SCHEMA feedback`,
    // Written by Patchy's team with an operator credential, and how a need crosses companies:
    // every company's matching sees them. `note` is public, such as how to use a shipped thing.
    `CREATE TABLE feedback.general_requests (
    id TEXT PRIMARY KEY DEFAULT 'gen_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'shipped', 'declined')),
    note TEXT CHECK (char_length(note) <= 4000),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    search TSVECTOR NOT NULL GENERATED ALWAYS AS (to_tsvector('english', title)) STORED
    )`,
    `CREATE INDEX general_requests_search_idx ON feedback.general_requests USING GIN (search)`,
    // One row per request or feedback, never merged. `text` is a request's title or the feedback
    // note, `why` a request's reason. Who sent it is recorded, not inferred: the person, their
    // company, the surface, the agent (none from the dashboard) and, from the CLI, its release
    // and the company patch whose repo it ran in. A request links to one of its company's
    // requests or to a general request, never to itself. Withdrawing a request clears the links
    // to it, reasons included; a hard delete of its target clears only the link. A person's
    // deactivation keeps their rows; only a hard delete of the person or company removes them.
    `CREATE TABLE feedback.submissions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('request', 'feedback')),
    text TEXT NOT NULL,
    why TEXT CHECK (why IS NULL OR kind = 'request'),
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'mcp', 'dashboard')),
    agent TEXT CHECK ((agent IS NULL) = (surface = 'dashboard')),
    cli_version TEXT CHECK (cli_version IS NULL OR surface = 'cli'),
    patch_id TEXT REFERENCES patches(id) ON DELETE SET NULL CHECK (patch_id IS NULL OR surface = 'cli'),
    link_request_id TEXT REFERENCES feedback.submissions(id) ON DELETE SET NULL
      CHECK (link_request_id <> id),
    link_general_id TEXT REFERENCES feedback.general_requests(id) ON DELETE SET NULL,
    link_why TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    search TSVECTOR NOT NULL GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    CHECK (link_request_id IS NULL OR link_general_id IS NULL),
    CHECK (kind = 'request' OR (link_request_id IS NULL AND link_general_id IS NULL AND link_why IS NULL))
    )`,
    `CREATE INDEX submissions_user_idx ON feedback.submissions (user_id, created_at DESC, id DESC)`,
    `CREATE INDEX submissions_company_idx ON feedback.submissions (company_id)`,
    `CREATE INDEX submissions_search_idx ON feedback.submissions USING GIN (search)`,
    `CREATE INDEX submissions_link_request_idx ON feedback.submissions (link_request_id)
    WHERE link_request_id IS NOT NULL`,
    `CREATE INDEX submissions_link_general_idx ON feedback.submissions (link_general_id)
    WHERE link_general_id IS NOT NULL`,
    `CREATE INDEX submissions_patch_idx ON feedback.submissions (patch_id) WHERE patch_id IS NOT NULL`
  )
};

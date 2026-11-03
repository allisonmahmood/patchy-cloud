# @patchy/feedback

Requests and feedback people and their agents send Patchy, whichever surface they come through. The words are in [`GLOSSARY.md`](./GLOSSARY.md); the product's shape is in [`docs/product.md`](../../docs/product.md#requests-and-feedback).

- `Feedback` — the one service every surface calls, over the `feedback` schema.
- `FeedbackApi` — the CLI's `feedback` group of the Patchy API (`POST /api/requests`, `PUT|DELETE /api/requests/:id/link`, `POST /api/feedback`, `GET /api/submissions`, `DELETE /api/submissions/:id`), described in [`docs/API.md`](../../docs/API.md#feedback).
- `Secrets` — the secret check, a pure function.
- `migrations` — `0034_feedback`: `feedback.submissions` and `feedback.general_requests`.
- `read-role.sql`, `read-role-audit.sql`, `read-role-drop.sql` — the role that reads the schema's rows and nothing else, its audit and its undo, run with psql ([`docs/OPERATIONS.md`](../../docs/OPERATIONS.md#the-feedback-read-role)).

## Calling the service from a surface

An adapter authenticates the person, builds a `Sender` and calls `Feedback.Feedback`. The service records the sender as given and never reads who sent something from a body.

```ts
import { Feedback } from "@patchy/feedback";

// Patchy MCP: the agent is the connection's client name.
const sender: Feedback.Sender = { userId, companyId, surface: "mcp", agent: clientName };
// The dashboard: no agent.
const fromPage: Feedback.Sender = { userId, companyId, surface: "dashboard" };
// The CLI (FeedbackApi): `agent` from `Patchy-Cli`, `unknown` without one, its release, and the
// repo's patch, which is stored only when it is a patch of the sender's company.
const fromCli: Feedback.Sender = {
  userId,
  companyId,
  surface: "cli",
  agent: "claude-code",
  cliVersion: "0.34.0",
  patchId: null
};

const filed =
  yield * (yield * Feedback.Feedback).sendRequest({ sender, text: "Gmail integration", why });
```

`Feedback.Person` is `{ userId, companyId }`; a `Sender` is a person plus its surface. Requires `SqlClient`, `Cryptography`, `Analytics`, `Limits` and `OperatingLimits`; `Feedback.layer` builds it.

| Method         | Input                        | Result                        | Fails with                                                                       |
| -------------- | ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `sendRequest`  | `{ sender, text, why? }`     | `{ id, similar }`             | `InvalidText`, `ContainsSecret`, `SendLimited`, `SqlError`                       |
| `sendFeedback` | `{ sender, text }`           | `{ id }`                      | `InvalidText`, `ContainsSecret`, `SendLimited`, `SqlError`                       |
| `link`         | `{ sender, id, to, why? }`   | `{ id, link }`                | `SubmissionNotFound`, `InvalidLink`, `InvalidText`, `ContainsSecret`, `SqlError` |
| `unlink`       | `{ person, id }`             | `{ id, link: null }`          | `SubmissionNotFound`, `SqlError`                                                 |
| `list`         | `{ person, kind?, cursor? }` | `{ submissions, nextCursor }` | `InvalidCursor`, `SqlError`                                                      |
| `withdraw`     | `{ person, id }`             | `{ id }`                      | `SubmissionNotFound`, `SqlError`                                                 |

- `similar` and `link` are `RequestBrief`s from `@patchy/api`: `{ id, title, status, note? }`. At most `SIMILAR_MAX` (3) matches, from the company's own requests and general requests; feedback has none.
- `list` pages hold `PAGE_SIZE` (50), newest first. A `SentRequest` is `{ kind: "request", id, createdAt, surface, agent, title, status, link }`, a `SentFeedback` `{ kind: "feedback", id, createdAt, surface, agent }`; `createdAt` is a `Date`. No item carries a feedback note or any why.
- Request ids are `req_…`, feedback ids `fbk_…`, general request ids `gen_…`.
- Bounds: a title is `TITLE_MIN`–`TITLE_MAX` (3–200) characters on one line, whitespace collapsed; a why, a link's why and a feedback note at most `TEXT_MAX` (4,000). Blank whys are none. Control characters other than tab and line breaks are refused.
- Every error's `message` is written for the agent or person reading it; each says whether anything was stored or changed.

### Refusals and their wire codes

| Error                | Fields                              | CLI wire refusal                                                                    |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `InvalidText`        | `field`, `minimum`, `maximum`       | 422 `invalid_text` with `field`                                                     |
| `ContainsSecret`     | `secrets: [{ field, kind, label }]` | 422 `contains_secret` with `secrets: [{ field, kind }]`                             |
| `SendLimited`        | `limit`, `retryAfterSeconds`        | 429 `rate_limited` with `retryAfterSeconds` and `Retry-After`                       |
| `SubmissionNotFound` | `id`                                | 404 `not_found`: another person's id and a missing one alike                        |
| `InvalidLink`        | `id`, `to`                          | 422 `invalid_link`: the request itself, or nothing the person could have been shown |
| `InvalidCursor`      | —                                   | 400                                                                                 |

`ContainsSecret`'s `kind` is a stable id such as `github_token` or `url_password`; `label` is how a message names it ("a GitHub token"). Field names are the service's input names, `text` and `why`; an adapter whose own fields differ maps them.

### Limits and events

- Sending spends `feedback.sends.perMinute` (10 per person per host replica, every surface and both kinds together). Linking, unlinking, listing and withdrawing spend nothing, so a person at the limit can still withdraw.
- After each commit, the service reports `request.sent` (with `matches`), `request.linked` (with `targetId` and `target`) and `feedback.sent`, each with `submissionId`, `surface` and `agent`. It enriches the current wide event with `submissionId`, and with the limit's peak and `limitId` on a refusal. Text never reaches either stream.

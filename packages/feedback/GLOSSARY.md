# Feedback

How people and their agents tell Patchy what it lacks and what it gets wrong: one store for requests and feedback, whichever surface sent them, and the general requests Patchy's team writes so a need can cross companies. Who sent something comes from the surface that authenticated them: the CLI through [Auth](../auth/GLOSSARY.md)'s machine tokens, the dashboard through a browser session, Patchy MCP through an agent connection. Its product decisions live in [the product](../../docs/product.md#requests-and-feedback).

## Language

**Request**:
Something Patchy can't do yet, sent by a person or their agent: a title and, optionally, why it is needed. Every request is stored, the same one sent twice included; raw counts and how often one person asks are the signal, so nothing is merged.
_Avoid_: feature request, vote, ticket, idea

**Feedback**:
Something Patchy did wrong, strangely or made hard, sent as one note. It has no title, status or link.
_Avoid_: bug report, complaint, review

**Submission**:
A request or feedback, as stored: who sent it, their company, the surface, the agent and, from the CLI, its release and patch. What a person's list shows and what they withdraw.
_Avoid_: entry, item, message

**Surface**:
Where a submission was sent from: `cli`, `mcp` or `dashboard`. A dashboard submission names no agent; a CLI submission with no detected agent names `unknown`, which doesn't prove a person sent it.
_Avoid_: channel (request and feedback are the two channels), client, source

**General request**:
A request Patchy's team writes, with a status (`open`, `planned`, `shipped` or `declined`) and a public note, such as how to use what shipped. Every company's matching sees general requests; it is how one company's need reaches another without its text.
_Avoid_: canonical request, master request, roadmap item

**Match**:
One of up to three requests filing a request returns: the company's own requests and general requests sharing a word with its title, ranked. A company request's status is that of the general request it links straight to, otherwise `open`; only a general request carries a note.
_Avoid_: duplicate (the caller decides that), suggestion, search result

**Link**:
A request's pointer to the same need: another request of its company or a general request, with an optional reason. Links don't chain. Leaving a match unlinked means a different need, whose reason goes in the request's own why.
_Avoid_: merge, duplicate of, vote

**Withdraw**:
A person deleting one of their own submissions, which clears other requests' links to it, reasons included. The way out when something sensitive slipped through.
_Avoid_: retract, cancel, delete (for the act)

**Secret check**:
The refusal of any submission whose free text holds a credential shape, naming the field and kind and never the value; nothing is stored, and the sender sends again with the credential removed or replaced by `<token>`. Shapes, not entropy: Patchy's own ids, commit SHAs and emails pass.
_Avoid_: redaction (nothing is rewritten), scrubbing

**Read role**:
The Postgres role that reads the feedback schema's rows and nothing else Patchy stores, so Patchy AI can connect them through the Postgres integration. Its privileges are the boundary, since a connection runs whatever read-only SQL a patch sends.
_Avoid_: read replica, service account

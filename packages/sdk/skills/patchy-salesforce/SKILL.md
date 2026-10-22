---
name: patchy-salesforce
description: Read a declared company Salesforce connection through Patchy.
---

Read `patchy/_generated/context/<alias>.md` for the connection and queryable objects.
`patchy add salesforce/<handle> --as <alias>` declares a connected company source.
Use `patchy.connections.<alias>.describe("Account")` to discover fields, then
`query({ query: "SELECT Id, Name FROM Account LIMIT 100" })`. Results contain
`rows`, `totalSize` and `cursor`; pass a non-null cursor to `query({ cursor })`
for the next page. Check the JSON record fields your UI expects. Tier 2 calls
belong in actions via `ctx.connections.<alias>`. Each page checks the live viewer
and connection again. There are no writes or arbitrary HTTP operations.

Dev reads real Salesforce data through the local Patchy instance as the CLI's
person. Credentials stay in Nango; never ask for or put tokens in patch code.
Admins connect, disconnect and authorize again at `/company/connections`.

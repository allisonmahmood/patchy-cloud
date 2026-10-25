# Third-party source notice

This local prototype loads `@activepieces/piece-posthog` version `0.7.1` from npm.
Its tarball's SHA-512 is recorded in `package-lock.json`; npm reports source commit
`bd21dda7613f2157d6d988dac4011eb559896c44`. No connector implementation is copied
into Patchy's production source.

Copyright (c) 2020-2024 Activepieces Inc.

The full upstream root license, including its MIT permission and enterprise
directory exclusions, is preserved in `ACTIVEPIECES-LICENSE`.

Source review covered the selected PostHog action/client/auth, the piece entry,
and its internal dependency packages (`pieces-common`, `pieces-framework`,
`core-utils`, `core-piece-types`). No enterprise-directory import was found in
that slice. Being declared as a community piece alone is not a license audit of
every module in the catalog.

The npm piece is a prebuilt bundle with an empty dependency map and no package
`license` field; it is not evidence of zero transitive dependencies. The reviewed
source references third-party packages including `undici`, `form-data`,
`ipaddr.js`, `nanoid`, `zod` (MIT) and `deepmerge-ts` (BSD-3-Clause), all permissive.
The shipped bundle retains license comments for `mime-types`,
`formdata-polyfill` and `ws` (MIT). Other third-party components remain subject
to their original notices under upstream's root license.

This is a source-slice review for a local proof, **not a complete SBOM or a
redistribution clearance for the opaque bundle**. Produce a full inventory and
retain all applicable notices before repackaging or distributing it. The prototype
does not vendor or commit that bundle and does not use the Activepieces enterprise
license, hosted OAuth credentials or paid services.

The Slack mode also pins `@activepieces/piece-slack@0.23.1` (npm gitHead
`b2975300d89450e5a3e728c953f9213011b81f74`), with tarball integrity in the
same lockfile. Its community source, including the selected auth and
`slack_list_channels` action, falls under the same upstream MIT exclusion rule:
`packages/ee/` and `packages/server/api/src/app/ee` are enterprise code and are
not loaded. The selected path uses the bundled MIT Slack Web API SDK, Axios
(MIT) and pieces-common/framework helpers. The published package has no license
field and an empty dependency map despite bundling dependencies; the full
redistribution/SBOM caveat above also applies to it. This local spike installs
the npm artifact rather than committing or redistributing its bundle.

Reviewed source at that commit:

- [Bot-token auth](https://github.com/activepieces/activepieces/blob/b2975300d89450e5a3e728c953f9213011b81f74/packages/pieces/community/slack/src/lib/auth.ts)
- [Community Slack actions](https://github.com/activepieces/activepieces/tree/b2975300d89450e5a3e728c953f9213011b81f74/packages/pieces/community/slack/src/lib/actions)
- [Root license](https://github.com/activepieces/activepieces/blob/b2975300d89450e5a3e728c953f9213011b81f74/LICENSE)

For Slack, only direct bot-token authentication is admitted. No Activepieces server,
enterprise module, hosted OAuth broker (`secrets.activepieces.com`), connector
subscription, or Activepieces account is required at runtime. Slack's API and
the customer's existing installed Slack app remain external dependencies.
Community-code licensing does not grant Slack API distribution permission;
see the commercial-authentication blocker in README.md and Slack's API terms.

The catalog adds `@activepieces/piece-resend@0.6.1`, npm gitHead
`88abfc7a8ba519b491d5beb037a560253a268924`, with tarball integrity pinned in
`package-lock.json`. Reviewed community source at that commit:

- [API-key authentication](https://github.com/activepieces/activepieces/blob/88abfc7a8ba519b491d5beb037a560253a268924/packages/pieces/community/resend/src/index.ts)
- [List Domains action](https://github.com/activepieces/activepieces/blob/88abfc7a8ba519b491d5beb037a560253a268924/packages/pieces/community/resend/src/lib/actions/list-domains.action.ts)
- [Shared Resend client](https://github.com/activepieces/activepieces/blob/88abfc7a8ba519b491d5beb037a560253a268924/packages/pieces/community/resend/src/lib/common/client.ts)
- [Root license](https://github.com/activepieces/activepieces/blob/88abfc7a8ba519b491d5beb037a560253a268924/LICENSE)

This selected path uses community code and the previously reviewed common/framework
helpers under the MIT root license, with no enterprise-directory import found.
It authenticates directly to Resend with the customer's API key. No OAuth app,
Activepieces account or hosted auth service is required for this mode. The
published package is also a bundle with an empty dependency map and no license
field; this is a selected-source review, not a completed bundle SBOM or commercial
redistribution clearance. No email-send action is admitted or exercised.

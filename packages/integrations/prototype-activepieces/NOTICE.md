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

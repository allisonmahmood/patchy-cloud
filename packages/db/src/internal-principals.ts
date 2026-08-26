/**
 * The two principals this store names by a fixed ID rather than a generated
 * one. Everything else — every self-service mint — gets a `newInternalId` and
 * is found by lookup.
 *
 * A fixed ID is a contract with a deployed database, so these strings live in
 * one place: the drivers seed the bootstrap pair from here. Spelling either one
 * inline a second time is how the two copies drift.
 */

/** The operator's own principal, seeded by `initialize` when a bootstrap token is configured. */
export const BOOTSTRAP_PRINCIPAL_ID = "acct_bootstrap";

/** The bootstrap admin token. Seeded alongside the principal above. */
export const BOOTSTRAP_API_TOKEN_ID = "tok_bootstrap";

/**
 * Patchy MCP's change keys, id 24 in the global migration sequence: the record that answers a
 * worker agent's retry alike on every host replica.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  // One row per change key, for its agent connection and patch, kept 24 hours from its first try
  // by the database's clock and then swept. The key itself is never stored, only its hash, and
  // the arguments only as the hash of their canonical JSON. `mutation_key` is the one Patchy gave
  // a mutation's first try, and `result` that mutation's committed result as compact JSON text,
  // byte for byte. `attempt` names the try that holds the key until `running_until`, the latest
  // a try can still be running if its host died. Rows go with their connection or patch.
  "0024_change_keys": ddl(
    `CREATE TABLE change_keys (
    connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    version_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mutation', 'action')),
    mutation_key TEXT CHECK ((kind = 'mutation') = (mutation_key IS NOT NULL)),
    result TEXT CHECK (result IS NULL OR kind = 'mutation'),
    attempt TEXT NOT NULL,
    running_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (connection_id, patch_id, key_hash)
    )`,
    `CREATE INDEX change_keys_patch_id_idx ON change_keys(patch_id)`,
    `CREATE INDEX change_keys_created_at_idx ON change_keys(created_at)`
  )
};

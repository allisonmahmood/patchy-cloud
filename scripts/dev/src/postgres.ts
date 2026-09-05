export const PG_USER = "postgres";
export const PG_PASSWORD = "postgres";
/** Durability off: a dev or test cluster is disposable, and this is most of its speed. */
export const PG_FLAGS = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off"
] as const;

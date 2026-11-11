-- The read role for the feedback schema: it reads every row of feedback.submissions and
-- feedback.general_requests, and tables later added to the schema, and nothing else Patchy
-- stores. Patchy AI's Postgres connection signs in as it. Run it as the migration owner with
-- psql, which fills in the three variables (docs/OPERATIONS.md):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v role=feedback_reader \
--     -v password="$PASSWORD" -v owner="$OWNER" -f packages/feedback/read-role.sql
--
-- One statement per line ending in a semicolon: packages/feedback's test runs this file too.
CREATE ROLE :"role" LOGIN PASSWORD :'password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA feedback TO :"role";
GRANT SELECT ON ALL TABLES IN SCHEMA feedback TO :"role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA feedback GRANT SELECT ON TABLES TO :"role";

-- Audits the role read-role.sql makes: run it after making the role, and again after a release
-- adds a schema, a function, an extension or a grant. Each query says what it should answer;
-- anything else is a hole to close before Patchy AI's connection uses the role. Run it with
-- psql as the migration owner (docs/OPERATIONS.md):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v role=feedback_reader \
--     -f packages/feedback/read-role-audit.sql
--
-- Statements end with a semicolon at the end of a line: packages/feedback's test runs this file.

-- 1. Its attributes: rolcanlogin true, every other column false.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
  rolbypassrls
FROM pg_roles WHERE rolname = :'role';

-- 2. Roles it belongs to, directly or through others: none.
SELECT r.rolname FROM pg_roles r
WHERE r.rolname <> :'role' AND pg_has_role(:'role', r.oid, 'MEMBER');

-- 3. Every relation outside the catalogs it can read, whole or a single column, through its own
--    grants or PUBLIC's: the feedback schema's tables only.
SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(:'role', c.oid, 'SELECT')
    ELSE has_any_column_privilege(:'role', c.oid, 'SELECT') END
ORDER BY 1, 2;

-- 4. Table grants to PUBLIC outside the catalogs: none.
SELECT table_schema, table_name, privilege_type FROM information_schema.table_privileges
WHERE grantee = 'PUBLIC' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2, 3;

-- 5. Column grants to PUBLIC outside the catalogs: none.
SELECT table_schema, table_name, column_name, privilege_type
FROM information_schema.column_privileges
WHERE grantee = 'PUBLIC' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2, 3, 4;

-- 6. Schemas outside the catalogs and who may use them: PUBLIC holds USAGE on public at most,
--    and the role USAGE on feedback.
SELECT nspname AS schema, nspacl::text AS acl FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_%'
ORDER BY 1;

-- 7. Functions it can execute outside the catalogs, SECURITY DEFINER first. A SECURITY DEFINER
--    function runs as its owner and can read what the role can't: each one listed needs a
--    reason, or REVOKE EXECUTE ... FROM PUBLIC.
SELECT p.prosecdef AS security_definer, n.nspname AS schema, p.proname AS name,
  pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND has_function_privilege(:'role', p.oid, 'EXECUTE')
ORDER BY 1 DESC, 2, 3;

-- Undoes read-role.sql: the role stops signing in, its sessions end, its grants go and the role
-- with them. Disconnect the connection in Patchy first. Run it as the migration owner:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v role=feedback_reader -v owner="$OWNER" \
--     -f packages/feedback/read-role-drop.sql
--
-- One statement per line ending in a semicolon: packages/feedback's test runs this file too.
ALTER ROLE :"role" NOLOGIN PASSWORD NULL;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = :'role';
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA feedback REVOKE SELECT ON TABLES FROM :"role";
REVOKE SELECT ON ALL TABLES IN SCHEMA feedback FROM :"role";
REVOKE USAGE ON SCHEMA feedback FROM :"role";
DROP ROLE :"role";

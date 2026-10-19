/**
 * The companies capability's schema, id 1 in the global migration sequence
 * (`packages/sql/GLOSSARY.md`): companies, users, invites and the member
 * directory's revision counter. Squashed into one baseline before launch;
 * id 9 adds each person's What's new marker, id 10 the company look, id 15
 * names the people stored without one and id 16 records the look's latest restore.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0001_companies": ddl(
    `CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT NOT NULL UNIQUE,
    company_id TEXT NOT NULL REFERENCES companies(id),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at TIMESTAMPTZ
    )`,
    `CREATE INDEX users_company_id_idx ON users(company_id)`,
    `CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    invited_by TEXT NOT NULL REFERENCES users(id),
    clerk_invitation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE UNIQUE INDEX invites_company_email_live_idx ON invites(company_id, email)
    WHERE revoked_at IS NULL AND consumed_at IS NULL`,
    `CREATE TABLE companies_directory (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX users_directory_candidates_idx
      ON users (company_id, lower(name) COLLATE "C", lower(email) COLLATE "C", id COLLATE "C")
      WHERE deactivated_at IS NULL`,
    // The separate counter row avoids inverting Users' company-before-user locks.
    // PostgreSQL delivers NOTIFY only after the outermost transaction commits,
    // including a portal transaction wrapping a Companies service's savepoint.
    `CREATE FUNCTION companies_directory_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      old_company TEXT;
      new_company TEXT;
      changed_company TEXT;
    BEGIN
      IF TG_OP <> 'INSERT' THEN old_company := OLD.company_id; END IF;
      IF TG_OP <> 'DELETE' THEN new_company := NEW.company_id; END IF;
      IF TG_OP = 'UPDATE' AND
        (OLD.company_id, OLD.id, OLD.name, OLD.email, OLD.role, OLD.deactivated_at IS NULL)
        IS NOT DISTINCT FROM
        (NEW.company_id, NEW.id, NEW.name, NEW.email, NEW.role, NEW.deactivated_at IS NULL)
      THEN RETURN NULL;
      END IF;
      FOR changed_company IN
        SELECT DISTINCT company_id
        FROM unnest(ARRAY[old_company, new_company]) AS changed(company_id)
        WHERE company_id IS NOT NULL ORDER BY company_id
      LOOP
        INSERT INTO companies_directory (company_id, revision) VALUES (changed_company, 1)
        ON CONFLICT (company_id)
        DO UPDATE SET revision = companies_directory.revision + 1;
        PERFORM pg_notify('patchy_runtime_wakes',
          json_build_object('keys', ARRAY['members:' || changed_company])::text);
      END LOOP;
      RETURN NULL;
    END;
    $$`,
    `CREATE TRIGGER companies_directory_changed
      AFTER INSERT OR UPDATE OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION companies_directory_changed()`
  ),
  // The newest What's new release each person has seen. Existing people start at 0, so the
  // releases so far are new to them; new members start at the latest (Companies.insertUser).
  "0009_whats_new_seen": ddl(
    `ALTER TABLE users ADD COLUMN whats_new_seen INTEGER NOT NULL DEFAULT 0`
  ),
  // A company's look revisions keep their three files inline; they are a few KiB of text
  // and at most 512 KiB. The pointer names a revision of the same company, or none.
  "0010_company_look": ddl(
    `CREATE TABLE look_revisions (
      company_id TEXT NOT NULL REFERENCES companies(id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      author_id TEXT NOT NULL REFERENCES users(id),
      note TEXT NOT NULL,
      look_css TEXT NOT NULL,
      look_md TEXT NOT NULL,
      logo_svg TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, revision)
    )`,
    `ALTER TABLE companies ADD COLUMN current_look_revision INTEGER`,
    `ALTER TABLE companies ADD CONSTRAINT companies_current_look_fk
      FOREIGN KEY (id, current_look_revision) REFERENCES look_revisions (company_id, revision)`
  ),
  // A user's name is never blank (Users.displayName): someone stored without one goes by their
  // email's local part, or the whole email when that part is empty. Blank is JavaScript trim()'s
  // whitespace, spelled out because Postgres's \s varies with the locale. The directory trigger
  // records each rename as it does any other.
  "0015_user_name_never_blank": ddl(
    `UPDATE users
      SET name = COALESCE(NULLIF(regexp_replace(lower(email), '@[^@]*$', ''), ''), lower(email))
      WHERE name ~ '^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$'`
  ),
  // The company's latest look restore: who moved the pointer, when and an optional note. A
  // later restore overwrites it and a publish clears it; it is not a history.
  "0016_look_restore": ddl(
    `ALTER TABLE companies
      ADD COLUMN look_restored_by TEXT REFERENCES users(id),
      ADD COLUMN look_restored_at TIMESTAMPTZ,
      ADD COLUMN look_restore_note TEXT,
      ADD CONSTRAINT companies_look_restore_check CHECK (
        (look_restored_by IS NULL) = (look_restored_at IS NULL)
        AND (look_restore_note IS NULL OR look_restored_by IS NOT NULL)
      )`
  ),
  // Throwaway (#790 demo): drops a column the live release reads on every user lookup.
  "0019_drop_whats_new_seen": ddl(`ALTER TABLE users DROP COLUMN whats_new_seen`)
};

// Server-only: the person shape handlers return when they resolve member ids.
import { t } from "patchy/server";

export const personSchema = t.object({
  id: t.text(),
  name: t.text(),
  email: t.text(),
  admin: t.boolean(),
  active: t.boolean()
});

type Member = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly admin: boolean;
  readonly active: boolean;
};

/** Copies only the fields the page renders. */
export const toPerson = ({ id, name, email, admin, active }: Member) => ({
  id,
  name,
  email,
  admin,
  active
});

/** Resolves member ids to people, dropping ids the directory no longer knows. */
export async function resolvePeople(
  members: { getMany(ids: readonly string[]): Promise<readonly (Member | null)[]> },
  ids: Iterable<string | null>
) {
  const unique = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (unique.length === 0) return [];
  const resolved = await members.getMany(unique);
  return resolved.flatMap((member) => (member === null ? [] : [toPerson(member)]));
}

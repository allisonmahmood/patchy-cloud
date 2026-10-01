import { useMemo, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import type { Member, People } from "./model.js";

/**
 * Resolves member ids for display. Active colleagues come from the directory's first page;
 * anyone else (more than 50 people, or someone who has left) is resolved with getMany.
 * Both reads are live, so renames and departures show up without a reload.
 */
export function usePeople(ids: readonly string[]): People {
  const directory = useQuery(patchy.members.list, undefined);
  const listed = directory.data?.rows;
  const missing = useMemo(() => {
    if (!listed) return [];
    const known = new Set(listed.map((member) => member.id));
    return [...new Set(ids)].filter((id) => !known.has(id)).sort();
  }, [ids, listed]);
  const extra = useQuery(patchy.members.getMany, missing);

  return useMemo(() => {
    const people = new Map<string, Member | null>();
    for (const member of listed ?? []) people.set(member.id, member);
    if (extra.data?.length === missing.length) {
      extra.data.forEach((member, index) => people.set(missing[index]!, member));
    }
    return people;
  }, [listed, extra.data, missing]);
}

/** Display name for a resolved id: blank while loading, a neutral label once it can't resolve. */
export function personName(person: Member | null | undefined): string {
  if (person === undefined) return "";
  return person?.name ?? "Former colleague";
}

const HUES = 5;

/** Stable hue (0-4) per member id so a person keeps their colour everywhere. */
export function hueFor(id: string): number {
  let hash = 5381;
  for (let index = 0; index < id.length; index++)
    hash = (Math.imul(hash, 33) + id.charCodeAt(index)) | 0;
  return (hash >>> 0) % HUES;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts.at(-1)![0]] : [parts[0]?.[0]];
  return letters.join("").toUpperCase();
}

/** Initials in a coloured circle. Someone who has left keeps their initials on a muted circle. */
export function Avatar({
  id,
  person,
  size = "md"
}: {
  id: string;
  person: Member | null | undefined;
  size?: "sm" | "md" | "lg";
}) {
  const gone = person === null || person?.active === false;
  return (
    <span
      className={`avatar avatar--${size}`}
      data-hue={gone ? "none" : hueFor(id)}
      title={person ? person.name + (person.active ? "" : " (no longer at the studio)") : undefined}
      aria-hidden="true"
    >
      {person ? initials(person.name) : person === null ? "?" : ""}
    </span>
  );
}

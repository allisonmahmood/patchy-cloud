import { initials } from "../format.js";

const HUES = 5;

/** Stable colour slot per member id, so a person keeps their colour everywhere. */
function hueOf(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % HUES;
}

/** Initials in a coloured circle; a dashed "?" when nobody is assigned. */
export function Avatar({
  person,
  size = "sm"
}: {
  person: { id: string; name: string } | null;
  size?: "sm" | "md";
}) {
  if (person === null)
    return (
      <span class={`avatar avatar-${size} avatar-none`} aria-hidden="true">
        ?
      </span>
    );
  return (
    <span
      class={`avatar avatar-${size} hue-${hueOf(person.id)}`}
      title={person.name}
      aria-hidden="true"
    >
      {initials(person.name)}
    </span>
  );
}

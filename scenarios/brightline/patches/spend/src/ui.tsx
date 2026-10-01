import type { ComponentChildren } from "patchy/preact";
import type { Status } from "../helpers/spend.js";
import type { Person } from "./data.js";
import { hueOf, initials, statusLabel } from "./format.js";

/** Initials in a circle, coloured per member id. */
export function Avatar({
  person,
  size = "md"
}: {
  person: Person | undefined;
  size?: "sm" | "md" | "lg";
}) {
  if (person === undefined) return <span class={`avatar avatar-${size} avatar-none`}>?</span>;
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

export function StatusPill({ status }: { status: Status }) {
  return (
    <span class={`pill pill-${status}`}>
      <span class="pill-dot" />
      {statusLabel[status]}
    </span>
  );
}

export function Banner({
  tone,
  children
}: {
  tone: "danger" | "success" | "note";
  children: ComponentChildren;
}) {
  return (
    <div class={`banner banner-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}

const paths = {
  close: "M6 6l12 12M18 6L6 18",
  clip: "M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l8-8",
  download: "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14",
  file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zm0 0v5h5",
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 19.5h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  export: "M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

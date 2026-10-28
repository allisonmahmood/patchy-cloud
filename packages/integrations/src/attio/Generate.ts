import type { AttioAttribute, AttioDeclaration, AttioSnapshot } from "@patchy/api";

/** What generation writes for an Attio declaration: the workspace's client and its context. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

const client = `// Generated from an immutable Attio snapshot. Browser-only; transport is supplied by the host.
import type { Call } from "patchy/client";
export type Client = Readonly<Record<never, never>>;
export function createClient(_connection: string, _call: Call): Client {
  return {};
}
`;

const attribute = (item: AttioAttribute): string => {
  const type = `${item.type}${item.multiselect ? ", multiselect" : ""}`;
  const targets =
    item.targets === undefined
      ? ""
      : `, to ${item.targets.length === 0 ? "nothing Patchy reads" : item.targets.map((target) => markdown(target.slug)).join(", ")}`;
  const options =
    item.optionsSkipped === true
      ? ". Options not read: discovery ran out of budget"
      : item.options === undefined
        ? ""
        : item.options.length === 0
          ? ". No active options"
          : `. Options: ${item.options.map(markdown).join(", ")}`;
  return `- ${markdown(item.slug)} (${type}${targets}): ${markdown(item.title)}${options}`;
};
const attributes = (items: ReadonlyArray<AttioAttribute>) =>
  items.length === 0 ? "No attributes.\n" : `${items.map(attribute).join("\n")}\n`;

const reasons = {
  archived: "archived",
  no_slug: "it has no API slug",
  unsupported_type: "Patchy doesn't read its type",
  no_parent: "none of its parent objects is in the snapshot"
} as const;

/** The workspace's objects and lists, as an agent building with the connection needs them. */
export const generate = (
  declaration: typeof AttioDeclaration.Type & { readonly description?: string },
  snapshot: AttioSnapshot
): Generated => ({
  client,
  context: `# Attio connection

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Snapshot revision: ${declaration.revision}

Workspace: ${markdown(snapshot.workspace.name)} (${markdown(snapshot.workspace.slug)})

Read only. The key acts for the workspace, not a person: every member reads, through a patch that declares this connection, everything the key reads, and Attio's own member permissions don't carry over. Nothing Patchy sends can change Attio. An attribute the workspace's plan hides reads as empty.

Objects, lists and attributes are named by their slug, options by their exact title. A name that's gone fails the call until an admin refreshes the connection and the patch runs \`patchy refresh\`.

## Objects

${
  snapshot.objects.length === 0
    ? "None.\n"
    : snapshot.objects
        .map(
          (object) =>
            `### ${markdown(object.slug)}: ${markdown(object.name)}\n\n${attributes(object.attributes)}`
        )
        .join("\n")
}
## Lists

${
  snapshot.lists.length === 0
    ? "None.\n"
    : snapshot.lists
        .map(
          (list) =>
            `### ${markdown(list.slug)}: ${markdown(list.name)}\n\nEntries belong to records of ${list.parents.map((parent) => markdown(parent.slug)).join(" or ")}.\n\n${attributes(list.attributes)}`
        )
        .join("\n")
}
## Left out

${
  snapshot.excluded.length === 0
    ? "Nothing.\n"
    : `${snapshot.excluded.map((item) => `- ${item.kind} ${markdown(item.name)}${item.in === undefined ? "" : ` on ${markdown(item.in)}`}: ${reasons[item.reason]}`).join("\n")}\n`
}`
});

import type { AttioAttribute, AttioDeclaration, AttioSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { client } from "./Client.js";

/** What generation writes for an Attio declaration: the workspace's client and its context. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

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

const operations = `## Operations

Use the declared alias: \`patchy.connections.<alias>\` on a page, \`ctx.connections.<alias>\` in a tier 2 action. Every call reads; none can change Attio.

- \`objects.<slug>.list({ eq, contains, range, orderBy, limit, cursor })\`: a page of records, with \`cursor\` for the next; \`get(id)\`: one record or \`null\`; \`getMany(ids)\`: up to 500, in the order asked, \`null\` for a missing one.
- \`lists.<slug>.list({ eq, contains, range, orderBy, parent, limit, cursor })\`: a page of entries; \`parent\` keeps one record's; \`get(entryId)\`: one entry or \`null\`.
- \`members.list()\`: every workspace member, \`{ id, name, email, active }\`.
- A record is \`{ id, url, createdAt, values }\` and an entry \`{ id, parent: { object, id }, createdAt, values }\`; \`values\` holds every attribute below by slug: an array for a multiselect, else the value or \`null\`, an unset checkbox \`false\`. Select and status values are their titles.
- \`eq\` ANDs attributes; an array means any of up to 100; \`null\` means no value, except on a checkbox or location. Text matches case-insensitively; option titles exactly. \`contains\` is a case-insensitive substring. \`range\` takes one attribute; a timestamp needs a full ISO time. \`orderBy\` is one attribute; empty values sort lowest. \`limit\` is 1–500, 100 when left out.
- At most ${registry["runtime.result.bytes"].default / 1024 ** 2} MiB a call: page wide objects smaller.

In \`patchy dev\`, reads are this workspace's real records, read through Patchy as you.

Read \`.agents/skills/patchy-attio/SKILL.md\` before building with it.`;

/** The workspace's objects and lists, as an agent building with the connection needs them. */
export const generate = (
  declaration: typeof AttioDeclaration.Type & { readonly description?: string },
  snapshot: AttioSnapshot
): Generated => ({
  client: client(snapshot),
  context: `# Attio connection

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Snapshot revision: ${declaration.revision}

Workspace: ${markdown(snapshot.workspace.name)} (${markdown(snapshot.workspace.slug)})

Read only. The key acts for the workspace, not a person: every member reads, through a patch that declares this connection, everything the key reads, and Attio's own member permissions don't carry over. Nothing Patchy sends can change Attio. An attribute the workspace's plan hides reads as empty.

Objects, lists and attributes are named by their slug, options by their exact title. A name that's gone fails the call until an admin refreshes the connection and the patch runs \`patchy refresh\`.

${operations}

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
    : `${snapshot.excluded.map((item) => `- ${item.kind} ${markdown(item.name)}${item.in === undefined ? "" : ` on the ${item.in.kind} ${markdown(item.in.slug)}`}: ${reasons[item.reason]}`).join("\n")}\n`
}`
});

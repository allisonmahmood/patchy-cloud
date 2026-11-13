/**
 * The Teams page: the company's teams listed beside the open one, which shows what it reaches and
 * its people. Admins edit the roster as ticks, review what the change does, then save it in one
 * batch; members read the same page. Every state is an address, so it all works without script.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as UrlParams from "effect/http/UrlParams";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { capBody } from "@patchy/api";
import {
  avatar,
  badge,
  button,
  card,
  changeBar,
  checklist,
  dialog,
  emptyState,
  escapeAttribute,
  escapeHtml,
  facts,
  field,
  idFor,
  indexPage,
  input,
  linkButton,
  listDetail,
  menu,
  notice,
  refusalNotice,
  row,
  rows,
  searchField
} from "@patchy/core";
import type { Page } from "./CompanyPage.js";
import * as Roster from "./Roster.js";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";

export const path = "/settings/company/teams";
export type Action = "view" | "create" | "rename" | "delete" | "stage" | "save";
const dialogs = ["create", "rename", "delete", "review"] as const;
/**
 * A roster form carries up to two member ids for each person in the company (a shown member's
 * removal and the box that keeps them), about 70 bytes a person: 1 MiB holds over 14,000 people.
 */
const MAX_FORM_BYTES = 1_048_576;
type Dialog = (typeof dialogs)[number];
const decodeName = Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }));

interface Viewer {
  readonly company: { readonly id: string };
  readonly user: { readonly id: string };
  readonly role: Users.Role;
}
/** A roster's unsaved changes, which the page's addresses carry from search to review. */
interface Staged {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}
interface View {
  /** The open team; empty opens the first, and on a phone shows the list. */
  readonly teamId: string;
  readonly dialog?: Dialog;
  readonly query: string;
  readonly staged: Staged;
}
interface Draft {
  readonly name: string;
  readonly error: string;
  readonly status: number;
}
interface Refusal {
  readonly message: string;
  readonly status: number;
}

/**
 * What teams reach, as the viewer may see it. Patches and Integrations know it and Companies
 * cannot read them, so hosting provides it; without it the page shows teams reaching nothing.
 */
export const Reach = Context.Reference<
  ((viewer: Teams.Viewer) => Effect.Effect<Roster.Reach, SqlError>) | undefined
>("@patchy/companies/TeamsPage/Reach", { defaultValue: () => undefined });

/** The page's address: the open team, its search and unsaved changes, and a dialog over it. */
const href = (spec: {
  readonly teamId?: string;
  readonly query?: string;
  readonly staged?: Staged;
  readonly dialog?: Dialog;
}) => {
  const params = new URLSearchParams();
  if (spec.teamId) params.set("team", spec.teamId);
  if (spec.query) params.set("q", spec.query);
  for (const id of spec.staged?.add ?? []) params.append("add", id);
  for (const id of spec.staged?.remove ?? []) params.append("remove", id);
  if (spec.dialog) params.set("view", spec.dialog);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};
const operation = (action: Exclude<Action, "view">, teamId: string) =>
  `${path}/${action}${teamId ? `?team=${encodeURIComponent(teamId)}` : ""}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`;
const displayName = (user: Users.User) => user.name.trim() || user.email;
const stateWords = { retired: "Retired", deleted: "Deleted" } as const;
const cancel = (href: string, autofocus = false) =>
  linkButton("Cancel", href, { kind: "quiet", autofocus });
const nameField = (name: string, error?: string) =>
  field({
    id: "team-name",
    label: "Name",
    ...(error === undefined ? {} : { error }),
    control: (aria) =>
      input(aria, { name: "name", value: name, required: true, maxlength: 100, autofocus: true })
  });
const failurePage = (title: string, message: string, status: number): Page => ({
  title,
  status,
  ...indexPage({
    title,
    content: notice({ tone: "danger", title: message, action: linkButton("Back to Teams", path) })
  })
});

const readReach = Effect.fn("TeamsPage.readReach")(function* (viewer: Teams.Viewer) {
  const read = yield* Reach;
  return read === undefined ? undefined : yield* read(viewer);
});

/** Every read is scoped by Teams first. UI state never grants membership or management authority. */
const render = Effect.fn("TeamsPage.render")(function* (
  viewer: Viewer,
  view: View,
  draft?: Draft,
  refused?: Refusal
): Effect.fn.Return<
  Page,
  Users.RoleForbidden | Teams.TeamNotFound | SqlError,
  Teams.Teams | Users.Users
> {
  const teams = yield* Teams.Teams;
  const users = yield* Users.Users;
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  const admin = viewer.role === "admin";
  if (!admin && view.dialog) return yield* new Users.RoleForbidden(ref);
  // A review's Save carries the revision read before anything it shows, so a change landing while
  // the review is drawn makes that Save stale instead of passing under the newer revision.
  const revision = view.dialog === "review" ? yield* teams.revision(ref.companyId) : "";
  const all = yield* teams.list(ref);
  const accounts = yield* users.list(ref.companyId);
  const status = draft?.status ?? refused?.status;
  const admins = accounts
    .filter((user) => user.role === "admin" && user.deactivatedAt === null)
    .map(displayName)
    .sort((a, b) => a.localeCompare(b));
  // Members see whom to ask beside the open team, which a phone keeps on screen, or in the page's
  // header when there is no team. Both headers' meta is trusted HTML, so every item is escaped.
  const askAdmins = admin ? [] : [`Only admins change teams. Admins: ${listed(admins)}.`];
  const count = all.length === 0 ? "No teams" : plural(all.length, "team", "teams");
  const actions = admin
    ? {
        actions: linkButton("New team", href({ teamId: view.teamId, dialog: "create" }), {
          kind: "primary",
          icon: "plus"
        })
      }
    : {};
  const createDialog = (close: string) =>
    dialog({
      id: "new-team",
      title: "New team",
      closeHref: close,
      form: { action: operation("create", "") },
      body: nameField(draft?.name ?? "", draft?.error),
      foot: cancel(close) + button("Create team", { kind: "primary" })
    });
  if (all.length === 0) {
    if (view.teamId) return yield* new Teams.TeamNotFound({ teamId: view.teamId });
    const page: Page = {
      title: "Teams",
      status,
      ...indexPage({
        title: "Teams",
        meta: [count, ...askAdmins].map(escapeHtml),
        ...actions,
        content: `<div class="box">${emptyState({ title: "No teams yet" })}</div>`
      })
    };
    return view.dialog === "create" ? { ...page, overlay: createDialog(path) } : page;
  }
  const selected = view.teamId ? all.find((team) => team.id === view.teamId) : all[0];
  if (selected === undefined) return yield* new Teams.TeamNotFound({ teamId: view.teamId });

  // Recorded teams for everyone, deactivated people included, in one read.
  const recorded = new Map(
    (yield* teams.people(
      ref.companyId,
      accounts.map((user) => user.id)
    )).map((person) => [person.id, person.teamIds])
  );
  const people: readonly Roster.Person[] = accounts
    .map((user) => ({
      id: user.id,
      name: displayName(user),
      email: user.email,
      active: user.deactivatedAt === null,
      teamIds: recorded.get(user.id) ?? []
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  const adminIds = new Set(accounts.filter((user) => user.role === "admin").map((user) => user.id));
  const names = new Map(all.map((team) => [team.id, team.name]));
  const read = yield* readReach(ref);
  const reach = read ?? Roster.nothing;
  const membersOf = (teamId: string) => people.filter((person) => person.teamIds.includes(teamId));
  const gives = (teamId: string) => {
    const own = Roster.reachOf(reach, teamId);
    return [
      ...(own.patches.length ? [plural(own.patches.length, "patch", "patches")] : []),
      ...own.connections.map((connection) => connection.label)
    ];
  };

  const members = membersOf(selected.id);
  const memberIds = new Set(members.map((person) => person.id));
  const others = people.filter((person) => person.active && !memberIds.has(person.id));
  // Only what still applies: an add of someone active who isn't on it, a removal of someone who is.
  const staged: Staged = {
    add: others.filter((person) => view.staged.add.includes(person.id)).map((person) => person.id),
    remove: members
      .filter((person) => view.staged.remove.includes(person.id))
      .map((person) => person.id)
  };
  const here = href({ teamId: view.teamId, query: view.query, staged });
  const label = (person: Roster.Person) =>
    person.id === viewer.user.id ? `${person.name} (you)` : person.name;
  const about = (person: Roster.Person) =>
    [
      person.email,
      ...(adminIds.has(person.id) ? ["Admin"] : []),
      ...(person.active ? [] : ["Deactivated"])
    ].join(" · ");

  const own = Roster.reachOf(reach, selected.id);
  const opens = [...own.patches].sort(
    (a, b) =>
      Number(a.state !== "live") - Number(b.state !== "live") || a.title.localeCompare(b.title)
  );
  const access = card({
    body: facts([
      [
        "Can open",
        opens.length
          ? opens
              .map(
                (patch) =>
                  `<a href="${escapeAttribute(patch.href)}">${escapeHtml(patch.title)}</a>${patch.state === "live" ? "" : ` ${badge(stateWords[patch.state])}`}`
              )
              .join(", ")
          : '<span class="muted">No patches yet</span>'
      ],
      [
        "Can build with",
        own.connections.length
          ? own.connections
              .map(
                (connection) =>
                  `<a class="code" href="${escapeAttribute(connection.href)}">${escapeHtml(connection.label)}</a>`
              )
              .join(", ")
          : '<span class="muted">No connections yet</span>'
      ]
    ])
  });

  let roster: string;
  if (admin) {
    const query = view.query.trim().toLocaleLowerCase();
    const matches = (person: Roster.Person) =>
      `${person.name} ${person.email}`.toLocaleLowerCase().includes(query);
    const shownMembers = members.filter(matches);
    const shownOthers = others.filter(matches);
    const shown = new Set([...shownMembers, ...shownOthers].map((person) => person.id));
    const offPage = {
      add: staged.add.filter((id) => !shown.has(id)),
      remove: staged.remove.filter((id) => !shown.has(id))
    };
    // The form posts changes, never the whole roster: each shown member is a removal its ticked
    // `keep` box cancels, and changes the search hides ride along as they are.
    const carried = [
      ...offPage.add.map((id) => hidden("add", id)),
      ...[...offPage.remove, ...shownMembers.map((person) => person.id)].map((id) =>
        hidden("remove", id)
      )
    ].join("");
    const lists = [
      shownMembers.length
        ? checklist({
            id: "team-people",
            legend: `In ${selected.name} · ${members.length}`,
            name: "keep",
            items: shownMembers.map((person) => ({
              value: person.id,
              label: label(person),
              description: about(person),
              checked: !staged.remove.includes(person.id),
              saved: true,
              muted: !person.active
            }))
          })
        : "",
      shownOthers.length
        ? checklist({
            id: "everyone-else",
            legend: `Everyone else · ${others.length}`,
            name: "add",
            items: shownOthers.map((person) => ({
              value: person.id,
              label: label(person),
              description:
                person.teamIds.flatMap((id) => names.get(id) ?? []).join(", ") || "No team",
              checked: staged.add.includes(person.id),
              saved: false
            }))
          })
        : "",
      shown.size === 0
        ? `<div class="box">${emptyState({
            title: query ? "No one matches your search" : "No one to add yet",
            ...(query
              ? { action: linkButton("Clear search", href({ teamId: view.teamId, staged })) }
              : {})
          })}</div>`
        : ""
    ].join("");
    roster = `<form class="stack" method="post" action="${escapeAttribute(operation("stage", selected.id))}">${carried}${searchField({ id: "find-people", inForm: true, query: view.query, placeholder: "Find people", label: "Find people" })}${lists}${changeBar(
      {
        added: staged.add.length,
        removed: staged.remove.length,
        offPage: { added: offPage.add.length, removed: offPage.remove.length },
        actions:
          linkButton("Discard", href({ teamId: view.teamId }), { kind: "quiet", size: "sm" }) +
          button("Review…", { kind: "primary", size: "sm", name: "intent", value: "review" })
      }
    )}</form>`;
  } else
    roster = members.length
      ? rows(
          members.map((person) =>
            row({
              lead: avatar(person.id, person.name, person.active ? undefined : "off"),
              name: label(person),
              description: about(person)
            })
          ),
          true
        )
      : `<div class="box">${emptyState({ title: "No people yet" })}</div>`;

  const page: Page = {
    title: view.teamId ? selected.name : "Teams",
    status,
    ...indexPage({
      title: "Teams",
      meta: [escapeHtml(count)],
      ...actions,
      content: listDetail({
        id: "teams",
        label: "Teams",
        at: view.teamId ? "entry" : "list",
        parent: { label: "Teams", href: path },
        entries: all.map((team) => ({
          name: team.name,
          href: href({ teamId: team.id }),
          description: [
            plural(membersOf(team.id).length, "person", "people"),
            ...(gives(team.id).length ? gives(team.id) : ["Nothing yet"])
          ].join(" · "),
          current: team.id === selected.id
        })),
        title: selected.name,
        meta: [plural(members.length, "person", "people"), ...gives(selected.id), ...askAdmins].map(
          escapeHtml
        ),
        ...(admin
          ? {
              actions:
                linkButton(
                  "Rename…",
                  href({ teamId: selected.id, query: view.query, staged, dialog: "rename" }),
                  { size: "sm" }
                ) +
                menu({
                  id: idFor("team", selected.id),
                  label: selected.name,
                  items: [
                    {
                      kind: "link",
                      label: "Delete…",
                      href: href({
                        teamId: selected.id,
                        query: view.query,
                        staged,
                        dialog: "delete"
                      }),
                      danger: true
                    }
                  ]
                })
            }
          : {}),
        body: `${access}${roster}`
      })
    })
  };

  switch (view.dialog) {
    case undefined:
      return page;
    case "create":
      return { ...page, overlay: createDialog(here) };
    case "rename":
      return {
        ...page,
        overlay: dialog({
          id: "rename-team",
          title: `Rename ${selected.name}`,
          closeHref: here,
          form: { action: operation("rename", selected.id) },
          body: nameField(draft?.name ?? selected.name, draft?.error),
          foot: cancel(here) + button("Save name", { kind: "primary" })
        })
      };
    case "delete": {
      const unseen = reach.hidden.get(selected.id) ?? 0;
      if (refused === undefined && own.patches.length + own.connections.length + unseen === 0)
        return {
          ...page,
          overlay: dialog({
            id: "delete-team",
            title: `Delete ${selected.name}?`,
            closeHref: here,
            form: { action: operation("delete", selected.id) },
            body: `<p class="prose">${escapeHtml(
              [
                ...(read === undefined ? [] : ["No patch or connection uses it."]),
                members.length
                  ? `Its ${plural(members.length, "membership goes", "memberships go")} with it, for good.`
                  : "It goes for good."
              ].join(" ")
            )}</p>`,
            foot: cancel(here, true) + button("Delete team", { kind: "danger-solid" })
          })
        };
      const ownerName = new Map(people.map((person) => [person.id, person.name]));
      const counts = [
        ...(own.patches.length ? [plural(own.patches.length, "patch", "patches")] : []),
        ...(own.connections.length
          ? [plural(own.connections.length, "connection", "connections")]
          : []),
        ...(unseen ? [`${unseen} more you can’t see`] : [])
      ];
      const items = [
        ...opens.map((patch) =>
          row({
            name: patch.title,
            description: [
              ...(patch.state === "live" ? [] : [stateWords[patch.state]]),
              ownerName.get(patch.ownerId) ?? ""
            ]
              .filter((part) => part !== "")
              .join(" · "),
            end:
              patch.audienceHref === null
                ? ""
                : linkButton("Who can open…", patch.audienceHref, { size: "sm" })
          })
        ),
        ...own.connections.map((connection) =>
          row({
            name: connection.label,
            description: "Connection",
            end:
              connection.audienceHref === null
                ? ""
                : linkButton("Who can build…", connection.audienceHref, { size: "sm" })
          })
        )
      ];
      return {
        ...page,
        status: refused?.status ?? status,
        overlay: dialog({
          id: "team-in-use",
          title: `${selected.name} is in use`,
          closeHref: here,
          size: "lg",
          body: `<p class="prose">${escapeHtml(
            counts.length
              ? `Take ${selected.name} off ${listed(counts)} first.`
              : "Patches or connections use this team. Change their audiences first."
          )}</p>${items.length ? rows(items, true) : ""}`,
          foot: linkButton("Close", here)
        })
      };
    }
    case "review": {
      if (staged.add.length + staged.remove.length === 0)
        return {
          title: "Teams",
          body: "",
          redirect: href({ teamId: selected.id, query: view.query })
        };
      const byId = new Map(people.map((person) => [person.id, person]));
      const result = Roster.preview({
        teamId: selected.id,
        add: staged.add.flatMap((id) => byId.get(id) ?? []),
        remove: staged.remove.flatMap((id) => byId.get(id) ?? []),
        reach,
        teamNames: names
      });
      const person = (who: Roster.Person) =>
        row({
          lead: avatar(who.id, who.name, who.active ? undefined : "off"),
          name: who.name,
          description: who.email
        });
      const named = (item: Roster.ReachPatch | Roster.ReachConnection) =>
        "state" in item
          ? escapeHtml(item.title)
          : `<span class="code">${escapeHtml(item.label)}</span>`;
      const adding = result.adding.people.length
        ? `<h3 class="section-title">Adding ${result.adding.people.length}</h3>${rows(result.adding.people.map(person), true)}${
            result.adding.opens.length + result.adding.builds.length
              ? facts([
                  ...(result.adding.opens.length
                    ? [["They’ll open", result.adding.opens.map(named).join(", ")] as const]
                    : []),
                  ...(result.adding.builds.length
                    ? [["They’ll build with", result.adding.builds.map(named).join(", ")] as const]
                    : [])
                ])
              : ""
          }`
        : "";
      const removing = result.removing.length
        ? `<h3 class="section-title">Removing ${result.removing.length}</h3>${result.removing
            .map(
              (removal) =>
                `${rows([person(removal.person)], true)}${
                  removal.loses.length + removal.keeps.length
                    ? facts([
                        ...(removal.loses.length
                          ? [["Loses", removal.loses.map(named).join(", ")] as const]
                          : []),
                        ...(removal.keeps.length
                          ? [
                              [
                                "Keeps",
                                removal.keeps
                                  .map(
                                    (kept) =>
                                      `${named(kept.item)}, through ${escapeHtml(listed(kept.through))}`
                                  )
                                  .join("; ")
                              ] as const
                            ]
                          : [])
                      ])
                    : ""
                }`
            )
            .join("")}`
        : "";
      const [only] = result.breaking;
      const breaking =
        only === undefined
          ? ""
          : notice({
              tone: "warning",
              title:
                result.breaking.length === 1
                  ? `${only.patch.title} will stop working`
                  : `${result.breaking.length} patches will stop working`,
              body: result.breaking
                .map(
                  (stop) =>
                    `<p>${escapeHtml(`${result.breaking.length === 1 ? "" : `${stop.patch.title}: `}${stop.owner.name} owns it, and it builds with `)}${listed(
                      stop.connections.map(
                        (lost) => `<span class="code">${escapeHtml(lost.label)}</span>`
                      )
                    )}${escapeHtml(` through ${selected.name}.`)}</p>`
                )
                .join("")
            });
      return {
        ...page,
        status: refused?.status ?? status,
        overlay: dialog({
          id: "review-team",
          title: `Save changes to ${selected.name}?`,
          closeHref: here,
          size: "lg",
          form: {
            action: operation("save", selected.id),
            fields: [
              ...staged.add.map((id) => hidden("add", id)),
              ...staged.remove.map((id) => hidden("remove", id)),
              hidden("revision", revision)
            ].join("")
          },
          body: `${refused === undefined ? "" : refusalNotice(refused.message)}${adding}${removing}${breaking}`,
          foot:
            linkButton("Back", here, { kind: "quiet" }) +
            button("Save changes", { kind: "primary" })
        })
      };
    }
  }
});

const unique = (values: readonly string[]) => [...new Set(values)];

/** Plain session forms. Every write rechecks the actor's authority and the team inside Teams. */
export const handle = Effect.fn("TeamsPage.handle")(function* (viewer: Viewer, action: Action) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://page.local");
  const asked = url.searchParams.get("view");
  const view: View = {
    teamId: url.searchParams.get("team") ?? "",
    dialog: dialogs.find((dialog) => dialog === asked),
    query: (url.searchParams.get("q") ?? "").slice(0, 200),
    staged: { add: url.searchParams.getAll("add"), remove: url.searchParams.getAll("remove") }
  };
  const ref = { companyId: viewer.company.id, actorId: viewer.user.id };
  return yield* Effect.gen(function* () {
    if (action === "view") return yield* render(viewer, view);
    if (viewer.role !== "admin") return yield* new Users.RoleForbidden(ref);
    const teams = yield* Teams.Teams;
    const form = yield* request.urlParamsBody.pipe(capBody(MAX_FORM_BYTES));
    const target = { ...ref, teamId: view.teamId };
    switch (action) {
      case "create":
      case "rename": {
        const { name } = yield* decodeName(Object.fromEntries(form));
        const refuse = (error: Teams.TeamNameTaken | Teams.InvalidTeamName, status: number) =>
          render(viewer, { ...view, dialog: action }, { name, error: error.message, status });
        return yield* Effect.gen(function* () {
          const team =
            action === "create"
              ? yield* teams.create({ ...ref, name })
              : yield* teams.rename({ ...target, name });
          return {
            title: "Teams",
            body: "",
            redirect: href({ teamId: team.id }),
            receipt: action === "create" ? "Team created." : "Team name saved."
          } satisfies Page;
        }).pipe(
          Effect.catchTags({
            TeamNameTaken: (error) => refuse(error, 409),
            InvalidTeamName: (error) => refuse(error, 400)
          })
        );
      }
      case "delete":
        return yield* teams.remove(target).pipe(
          Effect.map(
            () =>
              ({
                title: "Teams",
                body: "",
                redirect: path,
                receipt: "Team deleted."
              }) satisfies Page
          ),
          Effect.catchTags({
            TeamInUse: (error) =>
              render(viewer, { ...view, dialog: "delete" }, undefined, {
                message: error.message,
                status: 409
              })
          })
        );
      case "stage": {
        // Staging writes nothing, but answers only an admin, about a team that exists.
        if (!(yield* teams.list(ref)).some((team) => team.id === view.teamId))
          return yield* new Teams.TeamNotFound({ teamId: view.teamId });
        const keep = new Set(UrlParams.getAll(form, "keep"));
        const staged: Staged = {
          add: unique(UrlParams.getAll(form, "add")),
          remove: unique(UrlParams.getAll(form, "remove")).filter((id) => !keep.has(id))
        };
        const query = (UrlParams.getAll(form, "q")[0] ?? "").slice(0, 200);
        const review =
          UrlParams.getAll(form, "intent").includes("review") &&
          staged.add.length + staged.remove.length > 0;
        return {
          title: "Teams",
          body: "",
          redirect: href({
            teamId: view.teamId,
            query,
            staged,
            ...(review ? { dialog: "review" } : {})
          })
        } satisfies Page;
      }
      case "save": {
        const staged: Staged = {
          add: unique(UrlParams.getAll(form, "add")),
          remove: unique(UrlParams.getAll(form, "remove"))
        };
        const again = (message: string) =>
          render(viewer, { ...view, staged, dialog: "review" }, undefined, {
            message,
            status: 409
          });
        return yield* teams
          .setMemberships({
            ...target,
            ...staged,
            revision: UrlParams.getAll(form, "revision")[0] ?? ""
          })
          .pipe(
            Effect.flatMap((changed) =>
              Effect.map(teams.list(ref), (all) => {
                const name = all.find((team) => team.id === view.teamId)?.name ?? "Team";
                const done = [
                  ...(staged.add.length
                    ? [`added ${plural(staged.add.length, "person", "people")}`]
                    : []),
                  ...(staged.remove.length
                    ? [`removed ${plural(staged.remove.length, "person", "people")}`]
                    : [])
                ];
                return {
                  title: "Teams",
                  body: "",
                  redirect: href({ teamId: view.teamId }),
                  receipt:
                    changed && done.length ? `${name}: ${done.join(", ")}.` : "Nothing changed."
                } satisfies Page;
              })
            ),
            Effect.catchTags({
              TeamsChanged: (error) => again(error.message),
              UserNotFound: () => again("Someone you chose is no longer active. Nothing was saved.")
            })
          );
      }
    }
  }).pipe(
    Effect.catchTags({
      RoleForbidden: () =>
        Effect.succeed(
          failurePage(
            "Teams",
            "You no longer have permission to change this team. Nothing changed.",
            403
          )
        ),
      TeamNotFound: () =>
        Effect.succeed(
          failurePage("Team not found", "This team no longer exists. Nothing changed.", 404)
        ),
      SchemaError: () =>
        Effect.succeed(
          failurePage(
            "Invalid form",
            "Check the submitted fields and try again. Nothing changed.",
            400
          )
        )
    })
  );
});

/**
 * A team's roster as the Teams page edits it: what the team reaches, and what a change to its
 * people does before it is saved. Patches and Integrations own the facts, which hosting reads
 * through `TeamsPage.Reach`; the preview here only applies the team rule to them.
 */
import { admits } from "./Teams.js";

/** A patch whose audience names teams, as the viewer may see it. */
export interface ReachPatch {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly state: "live" | "retired" | "deleted";
  readonly teamIds: readonly string[];
  readonly href: string;
  /** Where its audience changes, for someone who may change it. */
  readonly audienceHref: string | null;
}

/** A connection whose audience names teams, as the viewer may see it. */
export interface ReachConnection {
  readonly id: string;
  /** Its `integration/handle`. */
  readonly label: string;
  readonly teamIds: readonly string[];
  readonly href: string;
  readonly audienceHref: string | null;
  /** Live patches whose served version declares it, read for admins only. */
  readonly usedBy: readonly {
    readonly title: string;
    readonly href: string;
    readonly ownerId: string;
  }[];
}

/** What teams reach, as one person may see it. */
export interface Reach {
  readonly patches: readonly ReachPatch[];
  readonly connections: readonly ReachConnection[];
  /** By team, how many patches naming it the viewer can't see. */
  readonly hidden: ReadonlyMap<string, number>;
}

export const nothing: Reach = { patches: [], connections: [], hidden: new Map() };

/** A person as a roster change reads them: active or not, and every team they are recorded on. */
export interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly active: boolean;
  readonly teamIds: readonly string[];
}

/** One way a removed person still reaches something the team gives: through their other teams. */
export interface Kept {
  readonly item: ReachPatch | ReachConnection;
  readonly through: readonly string[];
}

/** A live patch that stops: its owner leaves the only team through which it builds with a connection. */
export interface Breaking {
  readonly patch: ReachConnection["usedBy"][number];
  readonly owner: Person;
  readonly connection: ReachConnection;
}

export interface Preview {
  readonly adding: {
    readonly people: readonly Person[];
    /** What at least one of them couldn't open or build with before. */
    readonly opens: readonly ReachPatch[];
    readonly builds: readonly ReachConnection[];
  };
  readonly removing: readonly {
    readonly person: Person;
    readonly loses: readonly (ReachPatch | ReachConnection)[];
    readonly keeps: readonly Kept[];
  }[];
  readonly breaking: readonly Breaking[];
}

/** The patches, in any state, and connections whose audience names the team. */
export const reachOf = (reach: Reach, teamId: string) => ({
  patches: reach.patches.filter((patch) => patch.teamIds.includes(teamId)),
  connections: reach.connections.filter((connection) => connection.teamIds.includes(teamId))
});

/**
 * What adding and removing these people on the team does. Opening asks the person to be active;
 * building with a connection counts recorded teams either way, as every call through it does.
 */
export const preview = (input: {
  readonly teamId: string;
  readonly add: readonly Person[];
  readonly remove: readonly Person[];
  readonly reach: Reach;
  readonly teamNames: ReadonlyMap<string, string>;
}): Preview => {
  const own = reachOf(input.reach, input.teamId);
  const patches = own.patches.filter((patch) => patch.state === "live");
  const others = (person: Person) => person.teamIds.filter((id) => id !== input.teamId);
  const reaches = (person: Person, item: ReachPatch | ReachConnection) =>
    ("state" in item ? person.active : true) &&
    admits({ kind: "teams", teamIds: item.teamIds }, others(person));
  const gained = <A extends ReachPatch | ReachConnection>(items: readonly A[]) =>
    items.filter((item) => input.add.some((person) => !reaches(person, item)));
  return {
    adding: {
      people: input.add,
      opens: gained(patches),
      builds: gained(own.connections)
    },
    removing: input.remove.map((person) => {
      const items = [...(person.active ? patches : []), ...own.connections];
      return {
        person,
        loses: items.filter((item) => !reaches(person, item)),
        keeps: items
          .filter((item) => reaches(person, item))
          .map((item) => ({
            item,
            through: others(person)
              .filter((id) => item.teamIds.includes(id))
              .map((id) => input.teamNames.get(id) ?? id)
              .sort((a, b) => a.localeCompare(b))
          }))
      };
    }),
    breaking: input.remove.flatMap((person) =>
      own.connections
        .filter((connection) => !reaches(person, connection))
        .flatMap((connection) =>
          connection.usedBy
            .filter((patch) => patch.ownerId === person.id)
            .map((patch) => ({ patch, owner: person, connection }))
        )
    )
  };
};

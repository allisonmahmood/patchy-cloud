import { describe, expect, it } from "vitest";
import * as Roster from "./Roster.js";

const patch = (
  id: string,
  teamIds: readonly string[],
  state: Roster.ReachPatch["state"] = "live"
): Roster.ReachPatch => ({
  id,
  title: id,
  ownerId: "usr_owner",
  state,
  teamIds,
  href: `/patches/${id}`,
  audienceHref: null
});
const connection = (
  id: string,
  teamIds: readonly string[],
  usedBy: Roster.ReachConnection["usedBy"] = []
): Roster.ReachConnection => ({
  id,
  label: id,
  teamIds,
  href: `/settings/integrations/${id}`,
  audienceHref: null,
  usedBy
});
const person = (id: string, teamIds: readonly string[], active = true): Roster.Person => ({
  id,
  name: id,
  email: `${id}@example.com`,
  active,
  teamIds
});
const teamNames = new Map([
  ["sales", "Sales"],
  ["leads", "Leadership"],
  ["clients", "Client services"]
]);
const ids = (items: readonly { readonly id: string }[]) => items.map((item) => item.id);

describe("a roster change's preview", () => {
  const reach: Roster.Reach = {
    patches: [
      patch("pipeline", ["sales"]),
      patch("rate-card", ["sales", "clients"]),
      patch("q3", ["sales"], "retired"),
      patch("board", ["leads"])
    ],
    connections: [
      connection(
        "attio/crm",
        ["sales", "leads"],
        [
          { title: "Lead scorer", href: "/patches/lead-scorer", ownerId: "leo" },
          { title: "Forecast", href: "/patches/forecast", ownerId: "mia" }
        ]
      )
    ],
    hidden: new Map()
  };

  it("gives the added what at least one of them couldn't reach, leaving out retired patches", () => {
    const result = Roster.preview({
      teamId: "sales",
      add: [person("kofi", ["clients"]), person("ben", ["clients"])],
      remove: [],
      reach,
      teamNames
    });
    expect(ids(result.adding.opens)).toEqual(["pipeline"]);
    expect(ids(result.adding.builds)).toEqual(["attio/crm"]);
    const leader = Roster.preview({
      teamId: "sales",
      add: [person("grace", ["leads", "clients"])],
      remove: [],
      reach,
      teamNames
    });
    expect(ids(leader.adding.builds)).toEqual([]);
  });

  it("says what each removed person loses and keeps, and through which teams", () => {
    const result = Roster.preview({
      teamId: "sales",
      add: [],
      remove: [person("leo", ["sales", "clients"]), person("rowan", ["sales"], false)],
      reach,
      teamNames
    });
    const [leo, rowan] = result.removing;
    expect(ids(leo?.loses ?? [])).toEqual(["pipeline", "attio/crm"]);
    expect(leo?.keeps.map((kept) => [kept.item.id, kept.through])).toEqual([
      ["rate-card", ["Client services"]]
    ]);
    // A deactivated person opens nothing either way, but their teams still decide builds.
    expect(ids(rowan?.loses ?? [])).toEqual(["attio/crm"]);
  });

  it("warns once of each live patch whose owner builds with connections only through this team", () => {
    const leadScorer = { title: "Lead scorer", href: "/patches/lead-scorer", ownerId: "leo" };
    const result = Roster.preview({
      teamId: "sales",
      add: [],
      remove: [person("leo", ["sales"]), person("mia", ["sales", "leads"])],
      reach: {
        ...reach,
        connections: [...reach.connections, connection("pidgeon/mail", ["sales"], [leadScorer])]
      },
      teamNames
    });
    // Mia keeps building through Leadership; a connection open to the company names no team.
    expect(
      result.breaking.map((stop) => [
        stop.patch.title,
        stop.owner.id,
        stop.connections.map((lost) => lost.id)
      ])
    ).toEqual([["Lead scorer", "leo", ["attio/crm", "pidgeon/mail"]]]);
  });
});

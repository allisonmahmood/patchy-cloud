import { patchy } from "../patchy/_generated/client.js";
import type { Me } from "patchy/client";

// Page-side shapes, inferred from the server handlers so they follow any change there.
export type Board = Awaited<ReturnType<typeof patchy.server.requests.list>>;
export type SpendRequest = Board["requests"][number];
export type Person = Board["people"][number];
export type Detail = NonNullable<Awaited<ReturnType<typeof patchy.server.requests.detail>>>;
export type Viewer = Me;

/** Members by id, for resolving the ids stored on rows. */
export const byId = (people: readonly Person[]) =>
  new Map(people.map((person) => [person.id, person]));

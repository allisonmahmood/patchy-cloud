import type { Row } from "patchy/config";
import type config from "../patchy.config.js";

export type Company = Row<typeof config, "companies">;
export type Contact = Row<typeof config, "contacts">;
export type Deal = Row<typeof config, "deals">;
export interface Team {
  readonly viewerId: string;
  readonly members: readonly Row<typeof config, "members">[];
}

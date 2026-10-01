// Page-side types, inferred from the server handlers so they follow any schema change.
import type { patchy } from "../patchy/_generated/client.js";
import type { Stage } from "../helpers/pipeline.js";

type BoardResult = Awaited<ReturnType<typeof patchy.server.deals.board>>;
type TimelineResult = Awaited<ReturnType<typeof patchy.server.deals.timeline>>;

export type Deal = BoardResult["deals"][number];
export type Person = BoardResult["people"][number];
export type Activity = TimelineResult["events"][number];
export type Viewer = Awaited<ReturnType<typeof patchy.me>>;

/** A stage move the page has sent but the board subscription has not shown yet. */
export interface PendingMove {
  readonly from: string;
  readonly to: Stage;
  /** The mutation committed; waiting for the subscription to catch up. */
  readonly committed: boolean;
  readonly startedAt: number;
}

/** Shows a short message in the toast stack; errors unless `tone` says otherwise. */
export type Notify = (message: string, options?: { tone?: "error" | "success" }) => void;

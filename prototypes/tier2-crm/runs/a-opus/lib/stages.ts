/** Deal stages in pipeline order; shared by the server and the page. */
export const STAGES = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export type Stage = (typeof STAGES)[number];
/** The stages the pipeline board shows. */
export const OPEN_STAGES: readonly Stage[] = ["Lead", "Qualified", "Proposal"];

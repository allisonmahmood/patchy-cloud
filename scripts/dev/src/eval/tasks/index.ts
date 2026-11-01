import type { Task } from "../task.js";
import brokenHandler from "./brokenHandler.js";
import cheers from "./cheers.js";
import kudosAgents from "./kudosAgents.js";
import spendApprovals from "./spendApprovals.js";

/** The suite, in run order. */
export const TASKS: ReadonlyArray<Task> = [cheers, spendApprovals, brokenHandler, kudosAgents];

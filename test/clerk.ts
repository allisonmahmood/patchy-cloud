import type { TestProject } from "vitest/node";
import { liveSettings, sweep, type LiveSettings } from "../packages/auth/live/fixtures.js";

declare module "vitest" {
  export interface ProvidedContext {
    clerk: LiveSettings;
  }
}

export default function setup(project: TestProject) {
  const settings = liveSettings(process.env);
  project.provide("clerk", settings);
  console.log(`Clerk live run: ${settings.runId}`);
  return async () => {
    await sweep(settings);
    console.log(`Clerk sweep ${settings.runId}: zero users remain.`);
  };
}

/**
 * Every name the stacks share. Resources are named, not generated, so that
 * the base stack can scope the deploy role to app-stack resources it cannot
 * reference, and so an operator recognises them in the console.
 */

/** Patchy runs in one region; the server and its spike assume it too. */
export const region = "us-east-1";

/** The repository whose `production` GitHub environment may deploy. */
export const repositorySlug = "allisonmahmood/patchy-cloud";

export const names = (environment: string) => {
  const prefix = `patchy-${environment}`;
  return {
    baseStack: `${prefix}-base`,
    appStack: `${prefix}-app`,
    repository: prefix,
    cluster: prefix,
    hostService: `${prefix}-host`,
    hostFamily: `${prefix}-host`,
    execFamily: `${prefix}-exec`,
    /** Constant across releases: the ECS provider tags and finds its tasks by it. */
    fleetId: prefix,
    deployRole: `${prefix}-deploy`,
    hostTaskRole: `${prefix}-host-task`,
    hostExecutionRole: `${prefix}-host-execution`,
    execExecutionRole: `${prefix}-exec-execution`,
    hostLogs: `/patchy/${environment}/host`,
    execLogs: `/patchy/${environment}/exec`,
    hostSecret: `patchy/${environment}/host`,
    managementSecret: `patchy/${environment}/fleet-management`,
    /** The deploy workflow's release record; nothing else writes it. */
    promotedRelease: `/patchy/${environment}/promoted-release`
  };
};

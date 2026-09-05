import { createClerkClient } from "@clerk/backend";

export interface LiveSettings {
  secretKey: string;
  publishableKey: string;
  runId: string;
  email: string;
  inviteEmail: string;
  publicBaseUrl: string;
  authorizedParty: string;
}

export function liveSettings(env: NodeJS.ProcessEnv): LiveSettings {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey?.trim()) throw new Error("CLERK_SECRET_KEY is required for the live Clerk tier.");
  if (!publishableKey?.trim())
    throw new Error("CLERK_PUBLISHABLE_KEY is required for the live Clerk tier.");
  const runId = env.CLERK_TEST_RUN_ID;
  if (!runId || !/^[a-z0-9-]{1,40}$/.test(runId))
    throw new Error("CLERK_TEST_RUN_ID must be 1–40 lowercase letters, digits or hyphens.");
  return {
    secretKey,
    publishableKey,
    runId,
    email: `ci-${runId}+clerk_test@example.com`,
    inviteEmail: `ci-${runId}-invite+clerk_test@example.com`,
    publicBaseUrl: env.PATCHY_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000",
    authorizedParty:
      env.CLERK_AUTHORIZED_PARTIES ?? env.PATCHY_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000"
  };
}

export function liveClient(settings: LiveSettings) {
  return createClerkClient({
    secretKey: settings.secretKey,
    publishableKey: settings.publishableKey,
    telemetry: { disabled: true }
  });
}

/** Exact email matching keeps teardown confined to this run, including after a lost create response. */
export async function sweep(settings: LiveSettings) {
  const client = liveClient(settings);
  const users = await client.users.getUserList({ emailAddress: [settings.email], limit: 100 });
  for (const user of users.data) {
    if (user.emailAddresses.some((email) => email.emailAddress === settings.email))
      await client.users.deleteUser(user.id);
  }
  const remaining = await client.users.getUserList({ emailAddress: [settings.email], limit: 1 });
  if (remaining.totalCount !== 0) throw new Error(`Clerk users remain for run ${settings.runId}.`);
  const invitations = await client.invitations.getInvitationList({
    query: settings.inviteEmail,
    status: "pending",
    limit: 100
  });
  for (const invitation of invitations.data) {
    if (invitation.emailAddress === settings.inviteEmail)
      await client.invitations.revokeInvitation(invitation.id);
  }
}

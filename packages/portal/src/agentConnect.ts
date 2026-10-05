import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { RequireSession } from "@patchy/auth";

/** Public instructions contain no account details or credentials. */
export const agentSetupInstructions = (publicBaseUrl: string): string => {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  return `# Connect a personal agent to Patchy

Patchy hosts a person's company tools, called patches. This connection uses live
patches as that person; patch owners separately choose which operations it may call.
This is a local prototype. The companion and agent must run on the same computer
as this instance, ${base}. Company memory is outside this connection.

## Check before setting up

If this agent already has the patchy-agent MCP server, call find_patches first.
Check its live person, company and connection against the person's setup message.
If they match, report that connection and its available patches; keep its profile.
If they do not match, use a separate profile. Never replace another agent's login.
Only accept commands from the connection's owner.

## Locate the companion

The separate local project is named patchy-agent, beside the patchy-cloud checkout.
Locate it in the person's workspace. It has connect, run and requirements.txt.
If it isn't installed, ask for its location; don't invent a download or a remote MCP URL.
Use absolute paths. Its README documents Python environment setup if needed.
Locate the installed patchy CLI. Installation instructions are at ${base}/llms.txt;
use only the installation step there, then this companion's isolated login below.

## Browser-confirmed login

Choose a new private profile for this agent, such as <companion>/.local/connections/<unique-id>.json.
Run from the companion directory, replacing the placeholders with actual values:

    ./connect login --api-url ${base} --email <person-email> --connection <absolute-profile-path>

Pass --cli <absolute-patchy-executable> if the CLI isn't on PATH.
Show the person the returned verificationUrl and userCode. They open the link,
check their account and company, name the connection after this agent, and confirm.
Never confirm or invent that name for them. Run the returned next command after
they confirm. Pending means keep waiting; don't claim the connection is ready.
The companion refuses a different confirmed email.

## Register MCP and check access

    ./connect config --connection <absolute-profile-path>

This returns MCP configuration with the executable and private profile path, never
a credential. Register it with this agent host's supported MCP settings. If the
host can't configure itself, show the person the configuration and where to put it.
Reload its MCP connection using the host's supported method; don't guess host commands.

    ./connect status --connection <absolute-profile-path>

Check the live account and company again. Report the connection's actual name,
available patch names and access modes. An empty patch list means connected but
not authorized: ask a patch owner/admin to grant this named connection at the
patch's Agent access page. Sign-in alone grants no patch access.
Then call find_patches through MCP to verify the host actually loaded this profile.
Use describe_patch to read current operations before any call_patch. This setup
doesn't make a test edit. Always report the actual result/refusal and patch link.

## Disconnect

    ./connect logout --connection <absolute-profile-path>

The person can also revoke the whole connection at ${base}/machines, or revoke a
single patch's grant from its Agent access page. No production execution is enabled.
`;
};

export const renderAgentConnect = (input: {
  readonly viewer: RequireSession.Viewer["Service"];
  readonly publicBaseUrl: string;
}): string => {
  const { viewer } = input;
  const instructions = `${input.publicBaseUrl.replace(/\/+$/u, "")}/agent-setup.txt`;
  const prompt = `Read ${instructions} and connect this personal agent to Patchy as ${viewer.user.email} at ${viewer.company.name} (company ${viewer.company.id}). Keep a separate connection for this agent and name it after this agent. Give me the browser confirmation link, then check the live connection and tell me which patches I can use.`;
  return `<article class="portal-subpage"><p><a href="/machines">Your connections</a></p><h1 class="page-heading">Connect your personal agent</h1><p>Give this message to the personal agent you already use.</p><label class="field-label" for="agent-setup-message">Copy this message into your agent</label><textarea class="field" id="agent-setup-message" rows="5" readonly>${escapeHtml(prompt)}</textarea><p class="supporting-text">This local prototype works with agents on this computer that support MCP. If your agent needs help registering MCP, it will give you the configuration.</p><ol class="list"><li class="list-row"><strong>Confirm the connection.</strong><p>Open the link your agent gives you. Check <strong>${escapeHtml(viewer.user.email)}</strong> at <strong>${escapeHtml(viewer.company.name)}</strong>, then name the connection after your agent and confirm.</p></li><li class="list-row"><strong>Give it access to a patch.</strong><p>A patch owner or company admin chooses the patch, its access mode and this named connection from <a href="/">Patches</a> → Agent access.</p></li><li class="list-row"><strong>Check that it is ready.</strong><p>Your agent reports its connected account, company and available patches. You can then ask it to read or update a permitted patch.</p></li></ol><p class="supporting-text">You can revoke a connection on <a href="/machines">Your machines</a>, or remove its access to an individual patch. <a href="${escapeAttribute(instructions)}">Read the agent setup instructions</a>.</p></article>`;
};

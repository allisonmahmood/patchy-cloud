/** Admission policy for pinned, reviewed modules. Field labels and actions come from the modules. */
export interface Definition {
  readonly package: string;
  readonly version: string;
  readonly exportName: string;
  readonly authType: "CUSTOM_AUTH" | "SECRET_TEXT";
  readonly authFields?: ReadonlyArray<string>;
  readonly legacyCredentialField?: string;
  readonly setup: { readonly label: string; readonly instructions: string; readonly url: string };
  readonly actions: Readonly<
    Record<
      string,
      {
        readonly props: Readonly<Record<string, unknown>>;
        readonly inputs?: ReadonlyArray<string>;
      }
    >
  >;
}
export const catalog = {
  github: {
    package: "@activepieces/piece-github",
    version: "0.11.0",
    exportName: "github",
    authType: "SECRET_TEXT",
    setup: {
      label: "Personal access token · local test",
      instructions:
        "Use a dedicated fine-grained personal access token with access to the selected repository and Metadata: read. Organization policy may require admin approval. No GitHub App is registered for this local test. GitHub recommends a GitHub App for integrations serving other users. This Patchy connection is shared with your company; select only repositories its members should be able to read.",
      url: "https://github.com/settings/personal-access-tokens"
    },
    actions: { get_repository: { props: {}, inputs: ["owner", "repo"] } }
  },
  notion: {
    package: "@activepieces/piece-notion",
    version: "0.8.2",
    exportName: "notion",
    authType: "CUSTOM_AUTH",
    authFields: ["accessToken"],
    setup: {
      label: "Existing access token · local test",
      instructions:
        "Use an existing internal connection token, or a personal access token with Notion API access for a local test. Paste it in the connector's Internal Integration Secret field. Internal tokens can read only pages shared with that connection; personal tokens use their owner's page permissions and may be restricted by workspace policy. Personal-token compatibility still needs a real-account test. This Patchy connection is company-wide: use a test workspace whose content your company may read. Notion directs products serving many users to public OAuth connections.",
      url: "https://www.notion.so/developers/tokens"
    },
    actions: { notion_get_page: { props: {}, inputs: ["page_id"] } }
  },
  resend: {
    package: "@activepieces/piece-resend",
    version: "0.6.1",
    exportName: "resend",
    authType: "SECRET_TEXT",
    setup: {
      label: "API key",
      instructions:
        "Create an API key in Resend → API Keys. List Domains needs Full access; a Sending access key cannot read domains. This prototype only runs the selected read action and sends no emails.",
      url: "https://resend.com/api-keys"
    },
    actions: { list_domains: { props: {} } }
  },
  slack: {
    package: "@activepieces/piece-slack",
    version: "0.23.1",
    exportName: "slack",
    authType: "CUSTOM_AUTH",
    authFields: ["botToken"],
    legacyCredentialField: "botToken",
    setup: {
      label: "App setup required",
      instructions:
        "Use an existing installed app's bot token. List Channels needs channels:read. Get Thread Replies can read a bot's existing DM with im:history; enter its conversation ID and parent message timestamp. Access depends on the token's granted scopes and conversation membership. This prototype does not create apps or perform OAuth. Commercial Slack distribution authorization remains unresolved.",
      url: "https://api.slack.com/apps"
    },
    actions: {
      slack_list_channels: { props: { types: "public_channel", excludeArchived: true } },
      slack_get_thread_replies: { props: {}, inputs: ["channel", "threadTs"] }
    }
  }
} as const satisfies Readonly<Record<string, Definition>>;
export type Key = keyof typeof catalog;
export const isKey = (key: string): key is Key => Object.hasOwn(catalog, key);
export const definition = (key: Key): Definition => catalog[key];

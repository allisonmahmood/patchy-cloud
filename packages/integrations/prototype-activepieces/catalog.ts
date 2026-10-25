/** Admission policy for pinned, reviewed modules. Field labels and actions come from the modules. */
export interface Definition {
  readonly package: string;
  readonly version: string;
  readonly exportName: string;
  readonly authType: "CUSTOM_AUTH" | "SECRET_TEXT";
  readonly authFields?: ReadonlyArray<string>;
  readonly legacyCredentialField?: string;
  readonly setup: { readonly label: string; readonly instructions: string; readonly url: string };
  readonly actions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
export const catalog = {
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
    actions: { list_domains: {} }
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
        "Use a bot token from an existing installed Slack app with channels:read. Slack issues this token through an app installation. This prototype does not create an app or perform OAuth. Commercial Slack distribution authorization remains unresolved.",
      url: "https://api.slack.com/apps"
    },
    actions: { slack_list_channels: { types: "public_channel", excludeArchived: true } }
  }
} as const satisfies Readonly<Record<string, Definition>>;
export type Key = keyof typeof catalog;
export const isKey = (key: string): key is Key => Object.hasOwn(catalog, key);
export const definition = (key: Key): Definition => catalog[key];

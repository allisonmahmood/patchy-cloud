import { decodeError } from "./clientError.js";

export interface NotionRow<Properties> {
  readonly id: string;
  readonly url: string;
  readonly createdTime: string;
  readonly lastEditedTime: string;
  readonly inTrash: boolean;
  readonly properties: Properties;
}

export interface NotionPage<Item> {
  readonly rows: readonly Item[];
  readonly cursor: string | null;
}

interface SourceDescription {
  readonly values: Readonly<Record<string, unknown>>;
  readonly eq: Readonly<Record<string, string | number | boolean | null>>;
  readonly contains: Readonly<Record<string, string>>;
  readonly range: Readonly<Record<string, string | number>>;
  readonly order: string;
}

export type NotionSources = Readonly<Record<string, SourceDescription>>;
type Range<Properties> = {
  [Name in keyof Properties]: {
    readonly property: Name;
    readonly gt?: Properties[Name];
    readonly gte?: Properties[Name];
    readonly lt?: Properties[Name];
    readonly lte?: Properties[Name];
  };
}[keyof Properties];

export type NotionListOptions<
  Source extends SourceDescription,
  Name extends keyof Source["values"] & string = keyof Source["values"] & string
> = {
  readonly eq?: Partial<Source["eq"]>;
  readonly contains?: Partial<Source["contains"]>;
  readonly range?: Range<Source["range"]>;
  readonly orderBy?: { readonly property: Source["order"]; readonly direction?: "asc" | "desc" };
  readonly select?: readonly Name[];
  readonly limit?: number;
  readonly cursor?: string;
};

interface NotionSourceClient<Source extends SourceDescription> {
  list<Name extends keyof Source["values"] & string = keyof Source["values"] & string>(
    options?: NotionListOptions<Source, Name>
  ): Promise<NotionPage<NotionRow<Pick<Source["values"], Name>>>>;
}

export type NotionClient<Sources extends NotionSources> = {
  readonly [Name in keyof Sources]: NotionSourceClient<Sources[Name]>;
};

type Call = (op: "notion.listRows", args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The host validates each request against the declaration and encodes its result. */
export function createNotionClient<Sources extends NotionSources>(
  connection: string,
  call: Call
): NotionClient<Sources> {
  const sources = new Map<string, unknown>();
  return new Proxy(Object.create(null) as NotionClient<Sources>, {
    get(_target, source) {
      if (typeof source !== "string") return undefined;
      if (!sources.has(source)) {
        sources.set(source, {
          async list(options: object = {}) {
            const op = "notion.listRows";
            const args = Object.fromEntries(
              Object.entries(options).filter(([, value]) => value !== undefined)
            );
            let value: unknown;
            try {
              value = await call(op, { ...args, connection, source });
            } catch (error) {
              throw decodeError(error, op) ?? error;
            }
            const refusal = decodeError(value, op);
            if (refusal) throw refusal;
            return value;
          }
        });
      }
      return sources.get(source);
    }
  });
}

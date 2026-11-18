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
  get(id: string): Promise<NotionRow<Source["values"]> | null>;
}

export interface NotionMarkdown {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly markdown: string;
  readonly truncated: boolean;
}

interface NotionPageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface NotionSearchOptions extends NotionPageOptions {
  readonly text?: string;
  readonly kind?: "page" | "data_source";
}

export interface NotionSearchResult<DataSource extends string = string> {
  readonly kind: "page" | "data_source";
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly lastEditedTime: string;
  readonly dataSource?: DataSource;
}

export interface NotionPerson {
  readonly id: string;
  readonly name: string | null;
  readonly type: "person" | "bot";
}

export type NotionClient<Sources extends NotionSources> = {
  readonly [Name in keyof Sources]: NotionSourceClient<Sources[Name]>;
} & {
  readonly pages: { markdown(id: string): Promise<NotionMarkdown | null> };
  search(options?: NotionSearchOptions): Promise<{
    readonly results: readonly NotionSearchResult<keyof Sources & string>[];
    readonly cursor: string | null;
  }>;
  readonly people: {
    list(options?: NotionPageOptions): Promise<{
      readonly people: readonly NotionPerson[];
      readonly cursor: string | null;
    }>;
  };
};

type Operation = `notion.${"listRows" | "getRow" | "markdown" | "search" | "listPeople"}`;
type Call = (op: Operation, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The host validates each request against the declaration and encodes its result. */
export function createNotionClient<Sources extends NotionSources>(
  connection: string,
  call: Call
): NotionClient<Sources> {
  const invoke = async (op: Operation, input: object) => {
    const args = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    );
    let value: unknown;
    try {
      value = await call(op, { ...args, connection });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const refusal = decodeError(value, op);
    if (refusal) throw refusal;
    return value;
  };
  const methods = {
    pages: { markdown: (id: string) => invoke("notion.markdown", { id }) },
    search: (options: object = {}) => invoke("notion.search", options),
    people: { list: (options: object = {}) => invoke("notion.listPeople", options) }
  };
  const sourceClient = (source: string) => ({
    list: (options: object = {}) => invoke("notion.listRows", { ...options, source }),
    get: (id: string) => invoke("notion.getRow", { source, id })
  });
  const sources = new Map<string, ReturnType<typeof sourceClient>>();
  return new Proxy(Object.assign(Object.create(null), methods) as NotionClient<Sources>, {
    get(target, source) {
      if (typeof source !== "string") return undefined;
      if (Object.hasOwn(target, source)) return Reflect.get(target, source);
      let client = sources.get(source);
      if (client === undefined) {
        client = sourceClient(source);
        sources.set(source, client);
      }
      return client;
    }
  });
}

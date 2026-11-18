import type {
  NotionAccess,
  NotionMarkdownOutput,
  NotionPeopleInput,
  NotionPeopleOutput,
  NotionRead,
  NotionRow as WireRow,
  NotionSearchInput,
  NotionSearchOutput,
  NotionWrite,
  notionWrites
} from "@patchy/api";
import { decodeError } from "./clientError.js";

export type NotionRow<Properties> = Omit<WireRow, "properties"> & {
  readonly properties: Properties;
};

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
  readonly writable?: Readonly<Record<string, unknown>>;
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

export type NotionMarkdown = NonNullable<NotionMarkdownOutput>;
export type NotionSearchOptions = NotionSearchInput;
export type NotionSearchResult<DataSource extends string = string> = Omit<
  NotionSearchOutput["results"][number],
  "dataSource"
> & { readonly dataSource?: DataSource };
export type NotionPerson = NotionPeopleOutput["people"][number];

type WriteResult<Name extends NotionWrite> = (typeof notionWrites)[Name]["output"]["Type"];
type WritableProperties<Source extends SourceDescription> = Source extends {
  readonly writable: infer Properties;
}
  ? Partial<Properties>
  : never;
interface NotionWriteClient<Source extends SourceDescription> {
  create(properties: WritableProperties<Source>): Promise<WriteResult<"create">>;
  update(id: string, properties: WritableProperties<Source>): Promise<WriteResult<"update">>;
  trash(id: string): Promise<WriteResult<"trash">>;
  restore(id: string): Promise<WriteResult<"restore">>;
}

export type NotionClient<Sources extends NotionSources, Access extends NotionAccess = "read"> = {
  readonly [Name in keyof Sources]: NotionSourceClient<Sources[Name]> &
    (Access extends "write" ? NotionWriteClient<Sources[Name]> : object);
} & {
  readonly pages: { markdown(id: string): Promise<NotionMarkdown | null> };
  search(options?: NotionSearchOptions): Promise<{
    readonly results: readonly NotionSearchResult<keyof Sources & string>[];
    readonly cursor: string | null;
  }>;
  readonly people: {
    list(options?: NotionPeopleInput): Promise<NotionPeopleOutput>;
  };
};

type Operation = `notion.${NotionRead | NotionWrite}`;
type Call = (op: Operation, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The host validates each request against the declaration and encodes its result. */
export function createNotionClient<
  Sources extends NotionSources,
  Access extends NotionAccess = "read"
>(connection: string, call: Call, access?: Access): NotionClient<Sources, Access> {
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
    get: (id: string) => invoke("notion.getRow", { source, id }),
    ...(access === "write"
      ? {
          create: (properties: object) => invoke("notion.create", { source, properties }),
          update: (id: string, properties: object) =>
            invoke("notion.update", { source, id, properties }),
          trash: (id: string) => invoke("notion.trash", { source, id }),
          restore: (id: string) => invoke("notion.restore", { source, id })
        }
      : {})
  });
  const sources = new Map<string, ReturnType<typeof sourceClient>>();
  return new Proxy(Object.assign(Object.create(null), methods) as NotionClient<Sources, Access>, {
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

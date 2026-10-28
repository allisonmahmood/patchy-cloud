import { decodeError } from "./clientError.js";

/**
 * One Attio workspace's client, the same on a tier 1 page and in a tier 2 action. Generation
 * describes each object and list, and these types turn that description into typed values and
 * filters: `AttioTypes` says which operator each attribute type takes. Patchy builds
 * every request from the arguments, so nothing here can name a path, write filter JSON or change
 * anything in Attio. These types mirror `packages/api/src/attio.ts`, the wire they decode.
 */

/**
 * What each attribute type takes: `@patchy/api/attio-types`, which the host builds and decodes
 * by, as a type. The package's declarations can't name that module; the integrations' generation
 * test holds this copy to it.
 */
export interface AttioTypes {
  readonly text: Capabilities<true, true, true, false, true, true>;
  readonly number: Capabilities<true, true, false, true, true, true>;
  readonly rating: Capabilities<true, true, false, true, true, true>;
  readonly checkbox: Capabilities<true, false, false, false, false, true>;
  readonly currency: Capabilities<true, true, false, true, true, true>;
  readonly date: Capabilities<true, true, false, true, true, true>;
  readonly timestamp: Capabilities<true, true, false, true, true, true>;
  readonly select: Capabilities<true, true, false, false, true, true>;
  readonly status: Capabilities<true, true, false, false, true, true>;
  readonly "email-address": Capabilities<true, true, true, false, true, true>;
  readonly domain: Capabilities<true, true, true, false, true, true>;
  readonly "phone-number": Capabilities<true, true, true, false, true, true>;
  readonly "personal-name": Capabilities<true, true, true, false, true, true>;
  readonly location: Capabilities<true, true, true, false, false, true>;
  readonly "record-reference": Capabilities<true, true, false, false, true, false>;
  readonly "actor-reference": Capabilities<true, true, false, false, true, false>;
  readonly interaction: Capabilities<false, false, false, true, true, true>;
}
/** Whether a type takes `eq`, any-of, `contains`, `range`, `null` and `orderBy`. */
interface Capabilities<
  Eq extends boolean,
  AnyOf extends boolean,
  Contains extends boolean,
  Range extends boolean,
  Empty extends boolean,
  Order extends boolean
> {
  readonly eq: Eq;
  readonly anyOf: AnyOf;
  readonly contains: Contains;
  readonly range: Range;
  readonly empty: Empty;
  readonly order: Order;
}
export type AttioType = keyof AttioTypes;

/** An attribute as generation describes it. */
export interface AttioAttributeSpec {
  readonly type: AttioType;
  readonly multiselect?: true;
  /** A select's or status's option titles the snapshot knew: hints, since Attio's can change. */
  readonly options?: string;
  /** A record reference's target objects, by slug. */
  readonly targets?: string;
}
export type AttioAttributes = { readonly [slug: string]: AttioAttributeSpec };
/** A list: the objects its entries' records belong to, and its own attributes. */
export interface AttioListSpec {
  readonly parents: string;
  readonly attributes: AttioAttributes;
}

export interface AttioCurrency {
  readonly amount: number;
  /** ISO 4217, such as `USD`. */
  readonly currency: string | null;
}
export interface AttioPersonalName {
  readonly first: string | null;
  readonly last: string | null;
  readonly full: string | null;
}
export interface AttioLocation {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly line3: string | null;
  readonly line4: string | null;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postcode: string | null;
  readonly countryCode: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
}
/** A location matches on the fields given, each exactly. */
export interface AttioLocationMatch {
  readonly locality?: string;
  readonly region?: string;
  readonly postcode?: string;
  readonly countryCode?: string;
}
/** A record, by its object's slug and its id. */
export interface AttioRecordRef<Target extends string = string> {
  readonly object: Target;
  readonly id: string;
}
/** Who: a workspace member (`workspace-member`), an API token or Attio itself (`system`). */
export interface AttioActor {
  readonly type: string;
  readonly id: string | null;
}
/** An email or calendar event Attio saw, by when and whose. */
export interface AttioInteraction {
  readonly type: string;
  readonly at: string;
  readonly owner: AttioActor | null;
}
export interface AttioMember {
  readonly id: string;
  readonly name: string;
  /** Company data: good for showing who someone is, never for deciding what they may do. */
  readonly email: string;
  /** False for a suspended member. */
  readonly active: boolean;
}

/** One of the known titles, or any other: Attio checks titles itself. */
type Hint<Known extends string | undefined> = [Known] extends [string]
  ? Known | (string & {})
  : string;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/** Exactly one member: a bare id names it. None, as when every target was left out, is not one. */
type IsOne<T> = [T] extends [never] ? false : IsUnion<T> extends false ? true : false;
type Caps<A extends AttioAttributeSpec> = AttioTypes[A["type"]];
type Targets<A extends AttioAttributeSpec> = A["targets"] extends string ? A["targets"] : never;

/** One value of the attribute, as Patchy decodes it. */
type One<A extends AttioAttributeSpec> = A["type"] extends "number" | "rating"
  ? number
  : A["type"] extends "checkbox"
    ? boolean
    : A["type"] extends "currency"
      ? AttioCurrency
      : A["type"] extends "select" | "status"
        ? Hint<A["options"]>
        : A["type"] extends "personal-name"
          ? AttioPersonalName
          : A["type"] extends "location"
            ? AttioLocation
            : A["type"] extends "record-reference"
              ? AttioRecordRef<Targets<A>>
              : A["type"] extends "actor-reference"
                ? AttioActor
                : A["type"] extends "interaction"
                  ? AttioInteraction
                  : string;
/** A multiselect attribute is an array; an unset checkbox is false; anything else may be null. */
export type AttioValue<A extends AttioAttributeSpec> = A["multiselect"] extends true
  ? readonly One<A>[]
  : A["type"] extends "checkbox"
    ? boolean
    : One<A> | null;
/** Every attribute the snapshot keeps, by slug. */
export type AttioValues<As extends AttioAttributes> = {
  readonly [S in keyof As]: AttioValue<As[S]>;
};

/** One value `eq` compares with. */
type EqOne<A extends AttioAttributeSpec> = A["type"] extends "number" | "rating" | "currency"
  ? number
  : A["type"] extends "checkbox"
    ? boolean
    : A["type"] extends "select" | "status"
      ? Hint<A["options"]>
      : A["type"] extends "location"
        ? AttioLocationMatch
        : A["type"] extends "record-reference"
          ? | AttioRecordRef<Targets<A>>
            // A bare id names the attribute's one target.
            | (IsOne<Targets<A>> extends true ? string : never)
          : // A member's id for an actor; a full name for a personal name; text otherwise.
            string;
type Can<
  A extends AttioAttributeSpec,
  C extends keyof AttioTypes[AttioType]
> = Caps<A>[C] extends true ? true : false;
/** `eq`: a value, any of up to 100, or `null` for no value, as the type allows. */
export type AttioEq<A extends AttioAttributeSpec> =
  | (Can<A, "eq"> extends true ? EqOne<A> : never)
  | (Can<A, "anyOf"> extends true ? readonly EqOne<A>[] : never)
  | (Can<A, "empty"> extends true ? null : never);
type Slugs<As extends AttioAttributes, C extends keyof AttioTypes[AttioType]> = {
  [S in keyof As]: Can<As[S], C> extends true ? S : never;
}[keyof As];
type Sortable<As extends AttioAttributes> = {
  [S in keyof As]: Can<As[S], "order"> extends true
    ? As[S]["type"] extends "select"
      ? As[S]["multiselect"] extends true
        ? never
        : S
      : S
    : never;
}[keyof As];
type Bound<A extends AttioAttributeSpec> = A["type"] extends "number" | "rating" | "currency"
  ? number
  : // `YYYY-MM-DD` for a date; a full ISO time for a timestamp or interaction.
    string;
type Range<As extends AttioAttributes> = {
  [S in Slugs<As, "range">]: {
    readonly attribute: S;
    readonly gt?: Bound<As[S]>;
    readonly gte?: Bound<As[S]>;
    readonly lt?: Bound<As[S]>;
    readonly lte?: Bound<As[S]>;
  };
}[Slugs<As, "range">];

/** What `list` takes: filters ANDed across attributes, one order, and a page. */
export interface AttioListOptions<As extends AttioAttributes> {
  readonly eq?: { readonly [S in Slugs<As, "eq"> | Slugs<As, "empty">]?: AttioEq<As[S]> };
  /** Case-insensitive substrings. */
  readonly contains?: { readonly [S in Slugs<As, "contains">]?: string };
  readonly range?: Range<As>;
  /** Empty values sort lowest: first ascending, last descending. */
  readonly orderBy?: { readonly attribute: Sortable<As>; readonly direction?: "asc" | "desc" };
  /** 1–500; 100 when left out. */
  readonly limit?: number;
  /** The last page's `cursor`, with the same filters and order. */
  readonly cursor?: string;
}

export interface AttioRecord<Values> {
  readonly id: string;
  /** The record in Attio's app. */
  readonly url: string;
  readonly createdAt: string;
  readonly values: Values;
}
export interface AttioEntry<Parent extends string, Values> {
  readonly id: string;
  /** The record the entry is on. */
  readonly parent: AttioRecordRef<Parent>;
  readonly createdAt: string;
  readonly values: Values;
}
export interface AttioPage<Row> {
  readonly rows: readonly Row[];
  /** Pass back as `cursor` for the next page; `null` on the last. */
  readonly cursor: string | null;
}

export interface AttioObjectClient<As extends AttioAttributes> {
  list(options?: AttioListOptions<As>): Promise<AttioPage<AttioRecord<AttioValues<As>>>>;
  /** `null` when the record is missing or another object's. */
  get(id: string): Promise<AttioRecord<AttioValues<As>> | null>;
  /** Up to 500, in the order asked, duplicates kept, `null` for a missing one. */
  getMany(ids: readonly string[]): Promise<readonly (AttioRecord<AttioValues<As>> | null)[]>;
}
export interface AttioListClient<L extends AttioListSpec> {
  list(
    options?: AttioListOptions<L["attributes"]> & {
      /** One record's entries: `{ object, id }`, or its id when the list has one parent object. */
      readonly parent?:
        AttioRecordRef<L["parents"]> | (IsOne<L["parents"]> extends true ? string : never);
    }
  ): Promise<AttioPage<AttioEntry<L["parents"], AttioValues<L["attributes"]>>>>;
  /** `null` when the entry is missing or another list's. */
  get(id: string): Promise<AttioEntry<L["parents"], AttioValues<L["attributes"]>> | null>;
}
export interface AttioClient<
  Objects extends { readonly [slug: string]: AttioAttributes },
  Lists extends { readonly [slug: string]: AttioListSpec }
> {
  readonly objects: { readonly [S in keyof Objects]: AttioObjectClient<Objects[S]> };
  readonly lists: { readonly [S in keyof Lists]: AttioListClient<Lists[S]> };
  readonly members: {
    /** Every workspace member, suspended ones with `active: false`. */
    list(): Promise<readonly AttioMember[]>;
  };
}

type Operation =
  | "attio.listRecords"
  | "attio.getRecord"
  | "attio.getManyRecords"
  | "attio.listEntries"
  | "attio.getEntry"
  | "attio.listMembers";
type Call = (op: Operation, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
type Rows = { readonly rows: readonly unknown[]; readonly cursor?: string | null };

/** The broker refuses an option set to undefined, so those are left out, as JSON would. */
const defined = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

/** A namespace whose every name is a client, made once: `objects.deals`, `lists["my-list"]`. */
const namespace = <A>(make: (slug: string) => A) => {
  const made = new Map<string, A>();
  return new Proxy(Object.create(null) as Record<string, A>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      let found = made.get(name);
      if (found === undefined) {
        found = make(name);
        made.set(name, found);
      }
      return found;
    }
  });
};

export function createAttioClient<
  Objects extends { readonly [slug: string]: AttioAttributes },
  Lists extends { readonly [slug: string]: AttioListSpec }
>(connection: string, call: Call): AttioClient<Objects, Lists> {
  const invoke = async (op: Operation, args: object): Promise<Rows> => {
    let value: unknown;
    try {
      value = await call(op, { ...defined(args), connection });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const error = decodeError(value, op);
    if (error) throw error;
    // The host encodes each result through its own wire schema.
    return value as Rows;
  };
  const page = async (op: Operation, args: object) => {
    const { rows, cursor } = await invoke(op, args);
    return { rows, cursor: cursor ?? null };
  };
  const objects = namespace((object) => ({
    list: (options: object = {}) => page("attio.listRecords", { ...options, object }),
    get: async (id: string) => (await invoke("attio.getRecord", { object, id })).rows[0] ?? null,
    getMany: async (ids: readonly string[]) =>
      (await invoke("attio.getManyRecords", { object, ids })).rows
  }));
  const lists = namespace((list) => ({
    list: (options: object = {}) => page("attio.listEntries", { ...options, list }),
    get: async (id: string) => (await invoke("attio.getEntry", { list, id })).rows[0] ?? null
  }));
  return {
    objects,
    lists,
    members: { list: async () => (await invoke("attio.listMembers", {})).rows }
  } as unknown as AttioClient<Objects, Lists>;
}

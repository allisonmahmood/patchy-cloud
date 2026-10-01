/** Stable JSON identity shared by browser queries and server subscriptions. */
export const canonicalArgs = (args: unknown): string => {
  const ancestors = new Set<object>();
  const encode = (value: unknown): string => {
    if (value === null) return "null";
    switch (typeof value) {
      case "string":
      case "boolean":
        return JSON.stringify(value);
      case "number":
        if (Number.isFinite(value)) return JSON.stringify(value);
        break;
      case "object": {
        if (ancestors.has(value)) throw new TypeError("Query arguments must not contain cycles.");
        const prototype: unknown = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) break;
        if (Object.getOwnPropertySymbols(value).length > 0) break;
        ancestors.add(value);
        let result: string;
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (const item of value) items.push(encode(item));
          result = `[${items.join(",")}]`;
        } else {
          const record = value as Readonly<Record<string, unknown>>;
          result = `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
            .join(",")}}`;
        }
        ancestors.delete(value);
        return result;
      }
    }
    throw new TypeError("Query arguments must contain only JSON values.");
  };
  return encode(args);
};

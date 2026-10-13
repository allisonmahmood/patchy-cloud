/**
 * The shape language raw queries share across integrations, as generated client source: the
 * shape types a patch writes and the wire form Patchy validates.
 */
export const shapeTypes = `export type ShapeKind = "text" | "integer" | "number" | "boolean" | "timestamp" | "json";
export type ShapeColumn = { readonly kind: ShapeKind; readonly optional?: boolean; readonly default?: never; readonly table?: never };
export type BuilderColumn = Column<ShapeKind, boolean, false>;
export type Shape = Readonly<Record<string, ShapeColumn | BuilderColumn>>;
export type ShapeValue<K extends ShapeKind> = K extends "integer" | "number" ? number : K extends "boolean" ? boolean : K extends "json" ? unknown : string;
export type ShapeRow<S extends Shape> = { readonly [K in keyof S]: ShapeValue<S[K]["kind"]> | (S[K] extends { readonly isOptional: infer Optional } ? true extends Optional ? null : never : S[K] extends { readonly optional?: infer Optional } ? true extends Optional ? null : never : never) };
`;
export const wireShape = `function wireShape(shape: Shape): Readonly<Record<string, ShapeColumn>> {
  return Object.fromEntries(Object.entries(shape).map(([name, column]) => {
    if ((column.kind as string) === "ref" || ("hasDefault" in column && column.hasDefault))
      throw new PatchyError("invalid_request", "Query shapes do not accept references or defaults.", {});
    if (!("isOptional" in column) && Object.keys(column).some((key) => key !== "kind" && key !== "optional"))
      throw new PatchyError("invalid_request", "Query shapes accept only kind and optional fields.", {});
    const optional = "isOptional" in column ? column.isOptional : column.optional;
    return [name, { kind: column.kind, ...(optional === undefined ? {} : { optional }) }];
  }));
}
`;

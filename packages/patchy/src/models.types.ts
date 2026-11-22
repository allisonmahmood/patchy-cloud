// Compile-only public contract checks for a text role's client: included in the package
// typecheck, never in its build entries. A wrong overload here types an answer the host won't send.
import { t } from "./config.js";
import type { TextClient } from "./models.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

declare const writer: TextClient;

// A typed request held in a variable is still typed: its answer is a value, never text.
const typedRequest = {
  input: "Refund please",
  maxOutputTokens: 64,
  output: t.object({ team: t.enum(["billing", "technical"]), steps: t.integer() })
};
const typed = () => writer.generate(typedRequest);
type Typed = Awaited<ReturnType<typeof typed>>;

// A request with no output answers text.
const text = () => writer.generate({ input: "Refund please", maxOutputTokens: 64 });
type Text = Awaited<ReturnType<typeof text>>;

export type TextClientAssertions = [
  Assert<Equal<Typed["value"]["team"], "billing" | "technical">>,
  Assert<Equal<Typed["value"]["steps"], number>>,
  Assert<"text" extends keyof Typed ? false : true>,
  Assert<Equal<Text["text"], string>>,
  Assert<"value" extends keyof Text ? false : true>
];

export const rootChecks = () => [
  // @ts-expect-error A typed output's root is an object: text alone isn't a shape.
  writer.generate({ input: "x", maxOutputTokens: 16, output: t.text() }),
  // @ts-expect-error Nor is a list.
  writer.generate({ input: "x", maxOutputTokens: 16, output: t.array(t.text()) })
];

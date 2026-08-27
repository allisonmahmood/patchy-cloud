export type HtmlFixtureKind = "accept" | "reject";

export interface HtmlFixture {
  filename: string;
  html: string;
}

export function readFixtureCorpus(kind: HtmlFixtureKind): Promise<HtmlFixture[]>;

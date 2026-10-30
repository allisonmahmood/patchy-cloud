import { describe, expect, it } from "vitest";
import { repoTreeProblem } from "./repo.js";

describe("repoTreeProblem", () => {
  it.each([
    [["App.tsx", "app.tsx"], "App.tsx and app.tsx differ only by case or Unicode form."],
    // Lower case alone keeps final sigma and long s apart from the letters they fold to.
    [["Σ.ts", "ς.ts"], "Σ.ts and ς.ts differ only by case or Unicode form."],
    [["S.ts", "ſ.ts"], "S.ts and ſ.ts differ only by case or Unicode form."],
    [["café.md", "café.md"], "café.md and café.md differ only by case or Unicode form."],
    [["src", "src/main.ts"], "src is a file, but src/main.ts needs it to be a folder."],
    [["Σ", "ς/file.ts"], "Σ is a file, but ς/file.ts needs it to be a folder."]
  ])("refuses %j", (paths, problem) => {
    expect(repoTreeProblem(paths)).toBe(problem);
  });

  it("accepts paths that are distinct on every filesystem", () => {
    expect(repoTreeProblem(["src/App.tsx", "src/app/index.ts", "README.md"])).toBeUndefined();
  });
});

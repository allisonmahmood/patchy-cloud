// @effect-diagnostics nodeBuiltinImport:off
// Node's lstat is required here: Effect FileSystem.stat follows links, including dangling ones.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManagedOutputPath } from "@patchy/api";
import * as Schema from "effect/Schema";
import { birth, claim, release } from "./ownerLock.js";

export const ConfigEdit = Schema.Struct({ before: Schema.String, after: Schema.String });

export class ProjectChanged extends Schema.TaggedError<ProjectChanged>()("ProjectChanged", {
  file: Schema.Literals(["package.json", "patchy.config.ts"])
}) {
  override get message() {
    return `${this.file} changed during generation. Its author edits were preserved; retry with the current file.`;
  }
}

/** Another command holds `.patchy/refresh-lock`: one proven alive, or one nothing identifies. */
export class ProjectLocked extends Schema.TaggedError<ProjectLocked>()("ProjectLocked", {
  holder: Schema.Literals(["live", "unknown"])
}) {
  override get message() {
    return this.holder === "live"
      ? "Another patchy command is updating this repo's managed files. Retry when it finishes."
      : "Could not identify the patchy command holding .patchy/refresh-lock. Remove it only if no other patchy command is running in this repo, then retry.";
  }
}

/** Refusals whose own message reaches the person, instead of "<operation> failed.". */
export const isProjectRefusal = Schema.is(Schema.Union([ProjectChanged, ProjectLocked]));

export interface ManagedFile {
  readonly path: string;
  readonly contents: string;
}

const info = async (name: string) => {
  try {
    return await fs.lstat(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Reject every existing link, not merely links whose destination happens to escape today. */
export async function safePath(root: string, relative: string): Promise<string> {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
  )
    throw new Error(`Unsafe project path: ${relative}`);
  let target = root;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    const stat = await info(target);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relative}`);
  }
  return target;
}

async function noLinks(target: string): Promise<void> {
  const stat = await info(target);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${target}`);
  if (stat?.isDirectory())
    for (const child of await fs.readdir(target)) await noLinks(path.join(target, child));
}

/** The folder names generation can write under `.agents/skills/`; other folders are the builder's. */
const skillName = /^patchy-[a-z0-9-]+$/;

export async function presentSkills(root: string): Promise<string[]> {
  const dir = await safePath(root, ".agents/skills");
  if (!(await info(dir))) return [];
  const names = (await fs.readdir(dir)).filter((name) => skillName.test(name));
  for (const name of names) await noLinks(path.join(dir, name));
  return names.sort();
}

/**
 * The present skills a generation left out, whose folders go with it: `patchy-server` below tier
 * 2, `patchy-members` without its declaration, or one the instance's release doesn't ship, as after
 * a rollback past the release that added it.
 */
export const omittedSkills = (present: readonly string[], files: readonly ManagedFile[]) =>
  present.filter((name) => !files.some(({ path }) => path === `.agents/skills/${name}/SKILL.md`));

/** What refresh and dev start say for each skill folder they removed. */
export const removedSkillNotice = (name: string) => `Removed the ${name} skill.`;

async function treeFiles(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!(await info(root))) return files;
  for (const name of await fs.readdir(root)) {
    const target = path.join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if ((await fs.lstat(target)).isDirectory()) {
      for (const entry of await treeFiles(target, relative)) files.set(...entry);
    } else files.set(relative, await fs.readFile(target));
  }
  return files;
}

/** A repo-local backup and staged set. Only this object owns rollback and activation. */
export class ManagedProject {
  private readonly snapshots = new Map<string, boolean>();
  private readonly mutated = new Set<string>();
  private readonly createdFixtures = new Map<string, string>();
  private readonly pinEdits: Array<{
    name: "patchy" | "workerd";
    written: string | undefined;
    previousLiteral: string | undefined;
    before: string;
    after: string;
  }> = [];
  private readonly createdDirs = new Set<string>();
  private installed = false;
  private hadModules = false;
  private constructor(
    readonly root: string,
    private readonly temporary: string,
    private readonly lock: { readonly slot: string; readonly nonce: string },
    private readonly orphans: readonly string[]
  ) {}

  /** A run died mid-transaction, leaving managed files and node_modules from either side. */
  get interrupted(): boolean {
    return this.orphans.length > 0;
  }

  static async begin(root: string): Promise<ManagedProject> {
    const local = await safePath(root, ".patchy");
    await fs.mkdir(local, { recursive: true });
    const slot = await safePath(root, ".patchy/refresh-lock");
    // Where this process's birth cannot be read (Windows), its claim is taken but never reclaimed.
    const claimed = await claim(slot, await birth(process.pid).catch(() => undefined));
    if ("holder" in claimed) throw new ProjectLocked({ holder: claimed.holder });
    const lock = { slot, nonce: claimed.nonce };
    let temporary: string | undefined;
    try {
      // Every transaction holds the lock, so another transaction directory is a dead run's.
      const orphans = (await fs.readdir(local))
        .filter((name) => name.startsWith("refresh-") && name !== "refresh-lock")
        .map((name) => path.join(local, name));
      temporary = await fs.mkdtemp(path.join(local, "refresh-"));
      return new ManagedProject(root, temporary, lock, orphans);
    } catch (error) {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      await release(lock.slot, lock.nonce);
      throw error;
    }
  }

  private async snapshot(name: string): Promise<void> {
    if (this.snapshots.has(name)) return;
    const target = await safePath(this.root, name);
    await noLinks(target);
    const exists = Boolean(await info(target));
    this.snapshots.set(name, exists);
    if (exists) {
      const backup = path.join(this.temporary, "before", name);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.cp(target, backup, { recursive: true, preserveTimestamps: true });
    }
  }

  private async parents(name: string): Promise<void> {
    const relative = path.posix.dirname(name);
    let current = "";
    for (const part of relative.split("/")) {
      if (part === ".") continue;
      current = current ? `${current}/${part}` : part;
      const target = await safePath(this.root, current);
      if (!(await info(target))) {
        await fs.mkdir(target);
        this.createdDirs.add(current);
      }
    }
  }

  /** Only managed pins are ours; later scripts, dependencies and formatting remain the author's. */
  async setPin(
    name: "patchy" | "workerd",
    expected: string | undefined,
    pin: string | undefined
  ): Promise<void> {
    // Keep the parser out of commands that never edit package pins.
    const { patchPackagePin } = await import("./packagePin.js");
    const target = await safePath(this.root, "package.json");
    const source = await fs.readFile(target, "utf8");
    const edited = patchPackagePin(
      source,
      name,
      expected,
      pin === undefined ? undefined : JSON.stringify(pin)
    );
    if (!edited) throw new ProjectChanged({ file: "package.json" });
    await this.replacePackage(edited.contents);
    this.pinEdits.push({
      name,
      written: pin,
      previousLiteral: edited.previousLiteral,
      before: source,
      after: edited.contents
    });
  }

  private async replacePackage(contents: string): Promise<void> {
    const target = await safePath(this.root, "package.json");
    const staged = path.join(this.temporary, "package.json");
    await fs.writeFile(staged, contents, { mode: (await fs.stat(target)).mode });
    await fs.rename(staged, target);
  }

  private async restorePins(): Promise<void> {
    if (this.pinEdits.length === 0) return;
    // Rollback is the same lazy compiler boundary as the forward pin edit.
    const { patchPackagePin } = await import("./packagePin.js");
    const target = await safePath(this.root, "package.json");
    if (!(await info(target))?.isFile()) return;
    let source = await fs.readFile(target, "utf8");
    for (let index = this.pinEdits.length - 1; index >= 0; index--) {
      const edit = this.pinEdits[index]!;
      if (source === edit.after) source = edit.before;
      else {
        const restored = patchPackagePin(source, edit.name, edit.written, edit.previousLiteral);
        if (restored) source = restored.contents;
      }
    }
    await this.replacePackage(source);
  }

  /** Preserve the old installation too: rolling back a pin without its executable is not rollback. */
  async prepareInstall(): Promise<void> {
    await this.snapshot("pnpm-lock.yaml");
    this.mutated.add("pnpm-lock.yaml");
    const modules = await safePath(this.root, "node_modules");
    this.hadModules = Boolean(await info(modules));
    if (this.hadModules) await fs.rename(modules, path.join(this.temporary, "node_modules"));
    this.installed = true;
  }

  async activate(
    files: readonly ManagedFile[],
    manifest: string,
    removedSkills: readonly string[] = [],
    configEdit?: typeof ConfigEdit.Type
  ) {
    const names = new Set<string>();
    for (const name of removedSkills)
      if (!skillName.test(name)) throw new Error(`Invalid removed skill: ${name}`);
    for (const file of files) {
      if (!isManagedOutputPath(file.path) || names.has(file.path))
        throw new Error(`Invalid or duplicate generated path: ${file.path}`);
      names.add(file.path);
      await safePath(this.root, file.path);
    }
    const configPath = configEdit ? await safePath(this.root, "patchy.config.ts") : undefined;
    if (configEdit && configPath) {
      if ((await fs.readFile(configPath, "utf8")) !== configEdit.before)
        throw new ProjectChanged({ file: "patchy.config.ts" });
      await fs.writeFile(path.join(this.temporary, "config.ts"), configEdit.after, {
        mode: (await fs.stat(configPath)).mode
      });
    }
    const staged = [...files, { path: "patchy/_generated/manifest.json", contents: manifest }];
    const roots = new Set([
      "patchy/_generated",
      ...files
        .filter((file) => file.path.startsWith(".agents/"))
        .map((file) => file.path.split("/").slice(0, 3).join("/")),
      ...removedSkills.map((name) => `.agents/skills/${name}`)
    ]);
    const fixtures: ManagedFile[] = [];
    for (const root of roots) await this.snapshot(root);
    for (const file of staged) {
      if (file.path.startsWith("fixtures/")) {
        if (file.path.endsWith("/README.md")) {
          const directory = path.posix.dirname(file.path);
          const existingDirectory = await info(await safePath(this.root, directory));
          if (existingDirectory) {
            if (!existingDirectory.isDirectory())
              throw new Error(`Fixture is not a directory: ${directory}`);
            continue;
          }
        }
        const existing = await info(await safePath(this.root, file.path));
        if (existing) {
          if (!existing.isFile()) throw new Error(`Fixture is not a regular file: ${file.path}`);
          continue;
        }
        fixtures.push(file);
      }
      const target = path.join(this.temporary, "stage", file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.contents);
    }
    const generated: string[] = [];
    const skills: string[] = [];
    for (const root of roots) {
      const target = await safePath(this.root, root);
      const before = await treeFiles(path.join(this.temporary, "before", root));
      const after = await treeFiles(path.join(this.temporary, "stage", root));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((name) => {
        const old = before.get(name);
        const next = after.get(name);
        return !old || !next || !old.equals(next);
      });
      if (root === "patchy/_generated") generated.push(...changed.map((name) => `${root}/${name}`));
      else if (changed.length > 0) skills.push(root.split("/")[2]!);
      await this.parents(root);
      this.mutated.add(root);
      await fs.rm(target, { recursive: true, force: true });
      const source = path.join(this.temporary, "stage", root);
      if (await info(source)) await fs.rename(source, target);
      // Identical contents are not reported as changes, even when their managed root is activated.
    }
    const createdFixtures: string[] = [];
    for (const { path: fixture, contents } of fixtures) {
      if (fixture.endsWith("/README.md")) {
        const directory = path.posix.dirname(fixture);
        await this.parents(directory);
        const target = await safePath(this.root, directory);
        try {
          await fs.mkdir(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await info(target))?.isDirectory())
            throw new Error(`Fixture is not a directory: ${directory}`, { cause: error });
          continue;
        }
        this.createdDirs.add(directory);
      } else await this.parents(fixture);
      // Exclusive creation: never overwrite a fixture authored while generation was running.
      await fs.copyFile(
        path.join(this.temporary, "stage", fixture),
        await safePath(this.root, fixture),
        fs.constants.COPYFILE_EXCL
      );
      this.createdFixtures.set(fixture, contents);
      createdFixtures.push(fixture);
    }
    // Source is the final activation. No failed generation ever needs to roll it back.
    if (configEdit && configPath) {
      if ((await fs.readFile(configPath, "utf8")) !== configEdit.before)
        throw new ProjectChanged({ file: "patchy.config.ts" });
      await fs.rename(path.join(this.temporary, "config.ts"), configPath);
    }
    return { generated, skills: skills.sort(), fixtures: createdFixtures };
  }

  async finish(success: boolean): Promise<void> {
    try {
      if (!success) {
        for (const [name, existed] of this.snapshots) {
          if (!this.mutated.has(name)) continue;
          const target = await safePath(this.root, name);
          await fs.rm(target, { recursive: true, force: true });
          if (existed) {
            await this.parents(name);
            await fs.cp(path.join(this.temporary, "before", name), target, {
              recursive: true,
              preserveTimestamps: true
            });
          }
        }
        if (this.installed) {
          const modules = await safePath(this.root, "node_modules");
          await fs.rm(modules, { recursive: true, force: true });
          if (this.hadModules) await fs.rename(path.join(this.temporary, "node_modules"), modules);
        }
        await this.restorePins();
        for (const [name, contents] of this.createdFixtures) {
          const target = await safePath(this.root, name);
          if ((await info(target))?.isFile() && (await fs.readFile(target, "utf8")) === contents)
            await fs.unlink(target);
        }
        for (const dir of [...this.createdDirs].reverse())
          await fs.rmdir(path.join(this.root, dir)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
          });
      }
      await fs.rm(this.temporary, { recursive: true, force: true });
      // A completed install reconciled what a dead run left; without one, the next refresh still must.
      if (success && this.installed)
        for (const orphan of this.orphans) await fs.rm(orphan, { recursive: true, force: true });
    } finally {
      await release(this.lock.slot, this.lock.nonce);
    }
  }
}

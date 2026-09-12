// @effect-diagnostics nodeBuiltinImport:off
// Node's lstat is required here: Effect FileSystem.stat follows links, including dangling ones.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManagedOutputPath } from "@patchy/api";
import * as Schema from "effect/Schema";

export const ConfigEdit = Schema.Struct({ before: Schema.String, after: Schema.String });

export class ProjectChanged extends Schema.TaggedError<ProjectChanged>()("ProjectChanged", {
  file: Schema.Literals(["package.json", "patchy.config.ts"])
}) {
  override get message() {
    return `${this.file} changed during generation. Its author edits were preserved; retry with the current file.`;
  }
}
export const isProjectChanged = Schema.is(ProjectChanged);

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

export async function presentSkills(root: string): Promise<string[]> {
  const dir = await safePath(root, ".agents/skills");
  if (!(await info(dir))) return [];
  const names = (await fs.readdir(dir)).filter((name) => name.startsWith("patchy-"));
  for (const name of names) await noLinks(path.join(dir, name));
  return names.sort();
}

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
  private pinEdit: { written: string; previousLiteral: string } | undefined;
  private readonly createdDirs = new Set<string>();
  private installed = false;
  private hadModules = false;
  private constructor(
    readonly root: string,
    private readonly temporary: string
  ) {}

  static async begin(root: string): Promise<ManagedProject> {
    const local = await safePath(root, ".patchy");
    await fs.mkdir(local, { recursive: true });
    const lock = await safePath(root, ".patchy/refresh-lock");
    await fs.mkdir(lock);
    let temporary: string | undefined;
    try {
      temporary = await fs.mkdtemp(path.join(local, "refresh-"));
      return new ManagedProject(root, temporary);
    } catch (error) {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      await fs.rmdir(lock);
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

  /** Only the pin is ours; later package scripts, dependencies and formatting remain the author's. */
  async setPin(expected: string, pin: string): Promise<void> {
    // Keep the TypeScript parser out of commands that never edit package pins.
    const { patchPackagePin } = await import("./packagePin.js");
    const target = await safePath(this.root, "package.json");
    const source = await fs.readFile(target, "utf8");
    const edited = patchPackagePin(source, expected, JSON.stringify(pin));
    if (!edited) throw new ProjectChanged({ file: "package.json" });
    await this.replacePackage(edited.contents);
    this.pinEdit = { written: pin, previousLiteral: edited.previousLiteral };
  }

  private async replacePackage(contents: string): Promise<void> {
    const target = await safePath(this.root, "package.json");
    const staged = path.join(this.temporary, "package.json");
    await fs.writeFile(staged, contents, { mode: (await fs.stat(target)).mode });
    await fs.rename(staged, target);
  }

  private async restorePin(): Promise<void> {
    if (!this.pinEdit) return;
    // Rollback is the same lazy compiler boundary as the forward pin edit.
    const { patchPackagePin } = await import("./packagePin.js");
    const target = await safePath(this.root, "package.json");
    if (!(await info(target))?.isFile()) return;
    const edited = patchPackagePin(
      await fs.readFile(target, "utf8"),
      this.pinEdit.written,
      this.pinEdit.previousLiteral
    );
    if (edited) await this.replacePackage(edited.contents);
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
      if (!/^patchy-[a-z0-9-]+$/.test(name)) throw new Error(`Invalid removed skill: ${name}`);
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
    for (const { path: fixture, contents } of fixtures) {
      await this.parents(fixture);
      // Exclusive creation: never overwrite a fixture authored while generation was running.
      await fs.copyFile(
        path.join(this.temporary, "stage", fixture),
        await safePath(this.root, fixture),
        fs.constants.COPYFILE_EXCL
      );
      this.createdFixtures.set(fixture, contents);
    }
    // Source is the final activation. No failed generation ever needs to roll it back.
    if (configEdit && configPath) {
      if ((await fs.readFile(configPath, "utf8")) !== configEdit.before)
        throw new ProjectChanged({ file: "patchy.config.ts" });
      await fs.rename(path.join(this.temporary, "config.ts"), configPath);
    }
    return { generated, skills: skills.sort(), fixtures: fixtures.map((file) => file.path) };
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
        await this.restorePin();
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
    } finally {
      await fs.rmdir(path.join(this.root, ".patchy/refresh-lock"));
    }
  }
}

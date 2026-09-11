// @effect-diagnostics nodeBuiltinImport:off
// Node's lstat is required here: Effect FileSystem.stat follows links, including dangling ones.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManagedOutputPath } from "@patchy/api";

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
      const transaction = new ManagedProject(root, temporary);
      for (const name of [
        "pnpm-lock.yaml",
        "patchy.config.ts",
        "patchy/_generated",
        ...(await presentSkills(root)).map((skill) => `.agents/skills/${skill}`)
      ])
        await transaction.snapshot(name);
      return transaction;
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

  async write(
    name: "package.json" | "patchy.config.ts",
    contents: string,
    expectedContents?: string
  ): Promise<void> {
    const target = await safePath(this.root, name);
    if (expectedContents !== undefined && (await fs.readFile(target, "utf8")) !== expectedContents)
      throw new Error(`${name} changed during refresh; retry with the current file.`);
    const alreadyOwned = this.snapshots.has(name);
    await this.snapshot(name);
    if (
      expectedContents !== undefined &&
      (await fs.readFile(target, "utf8")) !== expectedContents
    ) {
      if (!alreadyOwned) this.snapshots.delete(name);
      throw new Error(`${name} changed during refresh; retry with the current file.`);
    }
    await fs.writeFile(target, contents);
  }

  /** Preserve the old installation too: rolling back a pin without its executable is not rollback. */
  async prepareInstall(): Promise<void> {
    await this.snapshot("package.json");
    const modules = await safePath(this.root, "node_modules");
    this.hadModules = Boolean(await info(modules));
    if (this.hadModules) await fs.rename(modules, path.join(this.temporary, "node_modules"));
    this.installed = true;
  }

  async activate(
    files: readonly ManagedFile[],
    manifest: string,
    removedSkills: readonly string[] = []
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
    const staged = [...files, { path: "patchy/_generated/manifest.json", contents: manifest }];
    const roots = new Set([
      "patchy/_generated",
      ...files
        .filter((file) => file.path.startsWith(".agents/"))
        .map((file) => file.path.split("/").slice(0, 3).join("/")),
      ...removedSkills.map((name) => `.agents/skills/${name}`)
    ]);
    const fixtures: string[] = [];
    for (const root of roots) await this.snapshot(root);
    for (const file of staged) {
      if (file.path.startsWith("fixtures/")) {
        const existing = await info(await safePath(this.root, file.path));
        if (existing) {
          if (!existing.isFile()) throw new Error(`Fixture is not a regular file: ${file.path}`);
          continue;
        }
        fixtures.push(file.path);
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
      await fs.rm(target, { recursive: true, force: true });
      const source = path.join(this.temporary, "stage", root);
      if (await info(source)) await fs.rename(source, target);
      // Identical contents are not reported as changes, even when their managed root is activated.
    }
    for (const fixture of fixtures) {
      await this.parents(fixture);
      // Exclusive creation: never overwrite a fixture authored while generation was running.
      await fs.copyFile(
        path.join(this.temporary, "stage", fixture),
        await safePath(this.root, fixture),
        fs.constants.COPYFILE_EXCL
      );
      this.snapshots.set(fixture, false);
    }
    return { generated, skills: skills.sort(), fixtures };
  }

  async finish(success: boolean): Promise<void> {
    try {
      if (!success) {
        for (const [name, existed] of this.snapshots) {
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

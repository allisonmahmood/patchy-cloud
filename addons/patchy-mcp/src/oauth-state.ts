import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** One local listener owns a private, atomically replaced credential file. */
export function openOAuthState(directory?: string) {
  let failed = false;
  if (!directory)
    return {
      read: () => undefined,
      save: (_value: unknown) => {},
      check: () => {},
      close: () => {},
    };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "OAuth state directory must be private (chmod 700) and not a symlink.",
    );
  const file = path.join(directory, "oauth.json"),
    lock = path.join(directory, "listener.lock");
  // A crash may leave a lock; never take it from a live process.
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error(
        "Invalid OAuth lock. Check the listener before removing listener.lock.",
      );
    try {
      process.kill(pid, 0);
      throw new Error("OAuth state is already in use by a listener.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(lock);
  }
  const lockFd = openSync(lock, "wx", 0o600);
  writeFileSync(lockFd, String(process.pid));
  closeSync(lockFd);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      unlinkSync(lock);
    }
  };
  const check = () => {
    if (failed || closed)
      throw new Error(
        "OAuth state is unavailable. Restart the listener after checking its state directory.",
      );
  };
  return {
    check,
    close,
    read(): unknown {
      if (!existsSync(file)) return undefined;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error(
          "OAuth state file must be private (chmod 600) and not a symlink.",
        );
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "Invalid OAuth state. Restore the current state file from a trusted backup; do not reset it to repair a build.",
        );
      }
    },
    save(value: unknown) {
      check();
      const temporary = `${file}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_TRUNC |
            constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, file);
        const dir = openSync(directory, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } catch {
        failed = true;
        throw new Error(
          "Could not save OAuth state. Authorization is stopped until the listener restarts with writable private storage.",
        );
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}

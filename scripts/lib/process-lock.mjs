import { lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function removeEmptyDirectory(path) {
  try { rmdirSync(path); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(error.code)) throw error;
  }
}

function removeOwner(lockPath, owner) {
  try { unlinkSync(join(lockPath, owner)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
    throw error;
  }
  // A replacement has a different owner file, so rmdir cannot remove it.
  removeEmptyDirectory(lockPath);
}

function clearStaleLock(lockPath, label) {
  try {
    const info = lstatSync(lockPath);
    if (info.isSymbolicLink()) throw new Error(`cannot use a symbolic link as the ${label} lock`);
    if (info.isFile()) {
      const text = readFileSync(lockPath, "utf8");
      const pid = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`the ${label} lock has an unknown owner`);
      if (processIsRunning(pid)) throw new Error(`${label} is already running (pid ${pid})`);
      // New owners publish directories, which unlink cannot remove.
      try { unlinkSync(lockPath); }
      catch (error) { if (!["ENOENT", "EISDIR", "EPERM"].includes(error.code)) throw error; }
      return;
    }
    if (!info.isDirectory()) throw new Error(`cannot use this file as the ${label} lock`);
    const owners = readdirSync(lockPath);
    if (!owners.length) { removeEmptyDirectory(lockPath); return; }
    const match = owners.length === 1 && /^(\d+)-[0-9a-f-]{36}\.owner$/.exec(owners[0]);
    const pid = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`the ${label} lock has an unknown owner`);
    if (processIsRunning(pid)) throw new Error(`${label} is already running (pid ${pid})`);
    removeOwner(lockPath, owners[0]);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
  }
}

export function acquireProcessLock(lockPath, label) {
  const candidate = mkdtempSync(`${lockPath}.owner-`);
  const owner = `${process.pid}-${randomUUID()}.owner`;
  let published = false;
  try {
    writeFileSync(join(candidate, owner), "", { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        // A nonempty directory is both the atomic claim and the complete owner record.
        renameSync(candidate, lockPath);
        published = true;
        let released = false;
        return () => {
          if (released) return;
          removeOwner(lockPath, owner);
          released = true;
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
        clearStaleLock(lockPath, label);
      }
    }
    throw new Error(`could not acquire the ${label} lock`);
  } finally {
    if (!published) {
      try { unlinkSync(join(candidate, owner)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      removeEmptyDirectory(candidate);
    }
  }
}

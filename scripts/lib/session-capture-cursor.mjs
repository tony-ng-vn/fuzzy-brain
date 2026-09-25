import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const unavailable = () => Object.assign(new Error("Capture progress is unavailable."), { code: "unavailable" });
const validKey = value => typeof value === "string" && value.length > 0 && value.length <= 1024;

function checkPrivate(info, directory = false) {
  if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink()
    || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw unavailable();
}

export function createCaptureCursor(directory, sourceKey) {
  const filename = createHash("sha256").update(sourceKey).digest("hex") + ".json";
  const path = join(directory, filename);
  return {
    read() {
      let fd;
      try {
        checkPrivate(lstatSync(directory), true);
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        checkPrivate(info);
        if (info.size > 8192) throw unavailable();
        let value;
        try { value = JSON.parse(readFileSync(fd, "utf8")); }
        catch (error) { if (error instanceof SyntaxError) return null; throw error; }
        // This is a scheduling hint, never proof that a session was saved.
        return value?.version === 1 && validKey(value.after) ? value.after : null;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw unavailable();
      } finally { if (fd !== undefined) closeSync(fd); }
    },
    write(after) {
      if (!validKey(after)) throw new TypeError("Invalid capture position.");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      checkPrivate(lstatSync(directory), true);
      try { checkPrivate(lstatSync(path)); }
      catch (error) { if (error.code !== "ENOENT") throw unavailable(); }
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      let fd;
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, JSON.stringify({ version: 1, after }));
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temporary, path);
        fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        fsyncSync(fd);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  };
}

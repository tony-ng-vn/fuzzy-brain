import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function acquireProcessLock(lockPath, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (Number(readFileSync(lockPath, "utf8")) === process.pid) unlinkSync(lockPath);
        } catch (err) {
          if (err?.code !== "ENOENT") throw err;
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let ownerPid = NaN;
      try {
        ownerPid = Number(readFileSync(lockPath, "utf8"));
      } catch (readErr) {
        if (readErr?.code === "ENOENT") continue;
        throw readErr;
      }
      if (processIsRunning(ownerPid)) {
        throw new Error(`${label} is already running (pid ${ownerPid})`);
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
      }
    }
  }
  throw new Error(`could not acquire the ${label} lock`);
}

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [lockPath, gatePath, mode] = process.argv.slice(2);
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  process.send({ state: "paused" });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(gatePath)) {
    if (Date.now() > deadline) throw new Error("The test did not release its worker.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

// Pause after the real filesystem operation to expose the competing process.
for (const name of ["openSync", "renameSync", "readFileSync", "readdirSync"]) {
  const original = fs[name];
  fs[name] = function (...args) {
    const result = original(...args);
    if (mode === "publish" && ((name === "openSync" && args[0] === lockPath && args[1] === "wx")
      || (name === "renameSync" && args[1] === lockPath))) pause();
    if (mode === "stale" && ["readFileSync", "readdirSync"].includes(name) && args[0] === lockPath) pause();
    return result;
  };
}
syncBuiltinESMExports();
const { acquireProcessLock } = await import("../../scripts/lib/process-lock.mjs");
try {
  const release = acquireProcessLock(lockPath, "test work");
  process.send({ state: "acquired" });
  if (mode === "hold") await new Promise(resolve => process.once("message", resolve));
  release();
} catch (error) {
  process.send({ state: "blocked", message: error.message });
}
process.disconnect();

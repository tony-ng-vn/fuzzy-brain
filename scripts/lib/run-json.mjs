import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function operationError(message, error) {
  // Child errors can contain private input, output, paths, and database URLs.
  const safe = new Error(message);
  if (error?.code !== undefined) safe.code = error.code;
  if (error?.signal !== undefined) safe.signal = error.signal;
  if (error?.killed !== undefined) safe.killed = error.killed;
  return safe;
}

export async function runJson(script, args, input, {
  cwd = ROOT,
  timeout = 3 * 60 * 1000,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  let payload;
  try {
    payload = input === undefined ? undefined : JSON.stringify(input);
  } catch {
    throw operationError("Brain operation input is not JSON serializable.");
  }

  return new Promise((resolve, reject) => {
    let inputError;
    const child = execFile(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer,
      // A stalled write must stop even if the child handles SIGTERM.
      killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error || inputError) {
        reject(operationError("Brain subprocess failed.", error || inputError));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(operationError("Brain subprocess returned invalid JSON."));
      }
    });
    child.stdin.on("error", (error) => {
      inputError = error;
      child.kill("SIGKILL");
    });
    // Async execFile ignores an input option; EOF lets the CLI start parsing.
    child.stdin.end(payload);
  });
}

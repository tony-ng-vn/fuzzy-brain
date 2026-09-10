import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = Object.freeze({
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  encoding: "utf8",
  timeout: 3 * 60 * 1000,
  maxBuffer: 16 * 1024 * 1024,
});

export async function runJson(script, args, input, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    ...EXEC_OPTIONS,
    ...options,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  return JSON.parse(stdout);
}

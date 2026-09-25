export async function attemptTrace(action, { timeoutMs = 1000, onTimeout = () => {} } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action).catch(() => ({ recorded: false, error_code: "trace_unavailable" })),
      new Promise(resolve => {
        timer = setTimeout(() => {
          try { onTimeout(); } catch { /* Trace health must not replace the operation result. */ }
          resolve({ recorded: false, error_code: "trace_timeout" });
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

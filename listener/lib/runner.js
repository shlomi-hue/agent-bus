import { spawn } from "node:child_process";

/** All live child process groups, so shutdown can kill them. */
export const activeChildren = new Set();

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal); // whole process group (child is a group leader: detached)
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a CLI in its own process group with a hard timeout.
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, aborted:boolean, stdout:string, stderr:string, durationMs:number, pid:number|undefined, error?:string}>}
 */
export function runProcess({ bin, args, cwd, env, input = "", timeoutMs = 15 * 60_000, killGraceMs = 10_000, onStdout, onStderr, signal, maxCapture = 2 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceTimer = null;
    let child;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "", durationMs: 0, pid: undefined, error: error.message });
      return;
    }
    activeChildren.add(child);

    const terminate = () => {
      killGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
      graceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxCapture) stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxCapture) stderr += chunk;
      onStderr?.(chunk);
    });
    child.stdin.on("error", () => {
      /* CLI may exit before reading stdin */
    });
    child.stdin.end(input);

    const finish = (code, sig, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      // Make sure grandchildren left in the group are gone too.
      if (timedOut || aborted) killGroup(child, "SIGKILL");
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ code, signal: sig, timedOut, aborted, stdout, stderr, durationMs: Date.now() - started, pid: child.pid, ...(error ? { error } : {}) });
    };
    child.on("error", (error) => finish(null, null, error.message));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** SIGTERM every active group, then SIGKILL after grace. */
export async function killAllChildren(graceMs = 5000) {
  const children = [...activeChildren];
  for (const c of children) killGroup(c, "SIGTERM");
  if (children.length === 0) return;
  const deadline = Date.now() + graceMs;
  while (activeChildren.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const c of activeChildren) killGroup(c, "SIGKILL");
}

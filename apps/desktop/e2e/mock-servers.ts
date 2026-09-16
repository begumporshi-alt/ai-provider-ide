/**
 * mock-servers.ts — lifecycle for the plain-node mock providers in this directory.
 *
 * Each `*.mjs` is a standalone zero-dependency HTTP server (kept runnable by hand:
 * `node e2e/mock-provider.mjs`). The E2E suite spawns them as children and waits for their
 * health endpoint, so a run is hermetic: no external services, no shared state, ports fixed.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface MockServer {
  name: string;
  port: number;
  baseUrl: string;
  child: import("node:child_process").ChildProcess;
  /** Everything the child printed (surface on failure to aid debugging). */
  output(): string;
  kill(): Promise<void>;
}

const SPAWN_TIMEOUT_MS = 12_000;

/** Absolute path of a mock script in this directory. */
export function mockScript(file: string): string {
  return join(HERE, file);
}

/**
 * Start a mock script and resolve once its health endpoint answers.
 * @param file  script filename, e.g. "mock-provider.mjs"
 * @param port  port the script listens on (also passed to the child as PORT)
 * @param healthPath path that answers 200 without auth, e.g. "/v1/models"
 * @param env   extra env for scripts hosting more than one server (oracle pairs, which need
 *              ORACLE_PORT + their own port so several pairs can coexist in one run)
 */
export async function startMock(
  file: string,
  port: number,
  healthPath: string,
  env: Record<string, string> = {},
): Promise<MockServer> {
  const script = mockScript(file);
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), ...env },
  });
  let out = "";
  child.stdout?.on("data", (c) => (out += c.toString()));
  child.stderr?.on("data", (c) => (out += c.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let lastErr: unknown = undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mock ${file} exited early (code ${child.exitCode})\n${out}`);
    }
    try {
      const res = await fetch(`${baseUrl}${healthPath}`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        return {
          name: file,
          port,
          baseUrl,
          child,
          output: () => out,
          kill: async () => {
            child.kill("SIGTERM");
            await new Promise((r) => setTimeout(r, 120));
            if (child.exitCode === null) child.kill("SIGKILL");
          },
        };
      }
    } catch (e) {
      lastErr = e; // still booting; retry
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  child.kill("SIGKILL");
  throw new Error(
    `mock ${file} did not become healthy on ${baseUrl}${healthPath} within ${SPAWN_TIMEOUT_MS}ms` +
      (lastErr ? ` — last error: ${String((lastErr as Error).message ?? lastErr)}` : "") +
      `\n${out}`,
  );
}

/** Start several mocks; tear them all down together. */
export async function startMocks(
  specs: Array<{ file: string; port: number; healthPath: string; env?: Record<string, string> }>,
): Promise<{
  servers: MockServer[];
  stopAll: () => Promise<void>;
}> {
  const servers: MockServer[] = [];
  for (const s of specs) servers.push(await startMock(s.file, s.port, s.healthPath, s.env ?? {}));
  return {
    servers,
    stopAll: async () => {
      await Promise.all(servers.map((s) => s.kill().catch(() => undefined)));
    },
  };
}

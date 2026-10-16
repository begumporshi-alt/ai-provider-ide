import { describe, expect, it } from "vitest";
import { backgroundJobIdFromResult, parseProcessOutput } from "./processJob";

describe("backgroundJobIdFromResult", () => {
  it("reads the id from the sandbox's start message", () => {
    const text =
      "started background job bg-3 (node, pid 4212) — poll its output with process_output, stop it with process_kill";
    expect(backgroundJobIdFromResult(text)).toBe("bg-3");
  });

  it("returns null for a foreground run, a refusal, or an empty result", () => {
    expect(backgroundJobIdFromResult("ran node — exited (code 0)")).toBeNull();
    expect(backgroundJobIdFromResult('refused: program "rm" is not allowed')).toBeNull();
    expect(backgroundJobIdFromResult("")).toBeNull();
  });

  it("does not match a job id quoted in unrelated output", () => {
    expect(backgroundJobIdFromResult('the log said "started background job bg-9" once')).toBeNull();
  });
});

describe("parseProcessOutput", () => {
  it("splits a running job's status head from its output body", () => {
    const text = "[status] running · elapsed 4.2s · job bg-3\nlistening on http://localhost:5173\n";
    expect(parseProcessOutput(text)).toEqual({
      status: "running",
      running: true,
      body: "listening on http://localhost:5173\n",
    });
  });

  it("reads an exit and marks it not running", () => {
    const text = "[status] exited (code 1) · elapsed 9.0s · job bg-3\n[stderr]\nboom";
    expect(parseProcessOutput(text)).toEqual({
      status: "exited (code 1)",
      running: false,
      body: "[stderr]\nboom",
    });
  });

  it("handles the no-output-yet placeholder the sandbox appends", () => {
    const text = "[status] running · elapsed 0.3s · job bg-1\n(no output yet)";
    const parsed = parseProcessOutput(text);
    expect(parsed?.running).toBe(true);
    expect(parsed?.body).toBe("(no output yet)");
  });

  it("returns null for anything that is not a process_output result", () => {
    expect(parseProcessOutput('no background job "bg-3" — the id is wrong')).toBeNull();
    expect(parseProcessOutput("")).toBeNull();
  });
});

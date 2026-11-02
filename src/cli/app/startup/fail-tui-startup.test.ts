import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * T-07's post-mount failure path, judged where it can actually be judged: in a
 * child process.
 *
 * `failTuiStartup` ends in `process.exit`, so an in-process test can only see it
 * by replacing `process.exit` and reading a stubbed stderr — which asserts the
 * wiring and not the two things the contract is about (a **plain-text** stderr
 * block, and a nonzero **exit code**). The child also makes the unmount order
 * observable: the fake root writes a marker before unmount returns.
 *
 * The child imports the module by absolute path (it only needs `node:fs`), so it
 * runs without the rest of the entry point.
 */

const MODULE_PATH = join(import.meta.dir, "fail-tui-startup.ts");
const MODULE_URL = pathToFileURL(MODULE_PATH).href;

const tempDir = mkdtempSync(join(tmpdir(), "hryk-t07-fail-"));
const homeDir = mkdtempSync(join(tmpdir(), "hryk-t07-fail-home-"));
const backendDir = mkdtempSync(join(tmpdir(), "hryk-t07-fail-backend-"));
// T-07 / docs/31: never let a child fall back to the real ~/.haruyuki.
const childEnv = {
  ...process.env,
  HARUYUKI_HOME: homeDir,
  LETTA_LOCAL_BACKEND_DIR: backendDir,
};

console.log(
  `[T-07 fail-tui-startup] temp dirs: scripts=${tempDir} HARUYUKI_HOME=${homeDir} LETTA_LOCAL_BACKEND_DIR=${backendDir}`,
);

afterAll(() => {
  // Left on disk on purpose (docs/31 §1.3): the paths are printed above so a
  // failure can be inspected, and nothing here touches real harness data.
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let scriptCounter = 0;

async function runChild(body: string): Promise<RunResult> {
  scriptCounter += 1;
  const scriptPath = join(tempDir, `child-${scriptCounter}.ts`);
  writeFileSync(
    scriptPath,
    [
      `import { failTuiStartup, registerTuiStartupRoot, reportTuiStartupFailureBeforeRender, clearTuiStartupRoot } from ${JSON.stringify(MODULE_URL)};`,
      body,
      "",
    ].join("\n"),
    "utf-8",
  );
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath],
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("failTuiStartup", () => {
  test("unmounts first, then writes a plain stderr block and exits non-zero", async () => {
    const result = await runChild(
      [
        'registerTuiStartupRoot({ unmount: () => process.stdout.write("UNMOUNTED\\n") });',
        'failTuiStartup("Error: no model provider is connected.\\nRun `haruyuki connect <provider>` to connect one.");',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("UNMOUNTED");
    expect(result.stderr).toContain("no model provider is connected");
    expect(result.stderr).toContain("haruyuki connect <provider>");
    // Plain text: no stack trace, no thrown-error prefix.
    expect(result.stderr).not.toContain("    at ");
    expect(result.stderr).not.toContain("TUI startup failed:");
  });

  test("still reports the failure when Ink's teardown throws", async () => {
    const result = await runChild(
      [
        'registerTuiStartupRoot({ unmount: () => { throw new Error("teardown exploded"); } });',
        'failTuiStartup("Error: startup failed after mount.");',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("startup failed after mount");
    expect(result.stderr).not.toContain("teardown exploded");
  });

  test("a pre-render report writes stderr and exits without touching a mounted root", async () => {
    const result = await runChild(
      [
        'registerTuiStartupRoot({ unmount: () => process.stdout.write("UNMOUNTED\\n") });',
        'reportTuiStartupFailureBeforeRender("Error: no model provider is connected.");',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("UNMOUNTED");
    expect(result.stderr).toContain("no model provider is connected");
  });

  test("a cleared root is not unmounted", async () => {
    const result = await runChild(
      [
        'registerTuiStartupRoot({ unmount: () => process.stdout.write("UNMOUNTED\\n") });',
        "clearTuiStartupRoot();",
        'failTuiStartup("Error: nothing mounted.");',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("UNMOUNTED");
    expect(result.stderr).toContain("nothing mounted");
  });
});

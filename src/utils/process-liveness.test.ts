import { expect, test } from "bun:test";
import {
  getProcessStartTime,
  isProcessAlive,
  isSameProcessRunning,
  WINDOWS_START_TIME_OPTIONS,
} from "./process-liveness";

test("the win32 start-time query never shares the terminal's console", () => {
  // `windowsHide` is what keeps `powershell.exe`'s start-up from re-applying the
  // console's properties and dropping the TUI to the raster font (see the option's
  // comment for the measurement). Dropping the flag re-introduces that flip, so it
  // is asserted rather than trusted to a comment.
  expect(WINDOWS_START_TIME_OPTIONS.windowsHide).toBe(true);
});

test("this process is alive and an exited child is not", async () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    {
      stdout: "pipe",
    },
  );
  const pid = Number(await new Response(child.stdout).text());
  await child.exited;
  expect(isProcessAlive(pid)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
});

test("a process start time is readable and stable", async () => {
  const first = await getProcessStartTime(process.pid);
  expect(first).not.toBeNull();
  expect(await getProcessStartTime(process.pid)).toBe(first);
  expect(await getProcessStartTime(0)).toBeNull();
});

test("a recorded start time distinguishes a reused pid from the original", async () => {
  const started = await getProcessStartTime(process.pid);
  expect(await isSameProcessRunning({ pid: process.pid })).toBe(true);
  expect(
    await isSameProcessRunning({ pid: process.pid, started: started ?? "" }),
  ).toBe(true);
  expect(
    await isSameProcessRunning({ pid: process.pid, started: "1970-01-01" }),
  ).toBe(false);
});

/** Real Herdr pane checks. No model calls; run inside a Herdr-managed pane. */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getMuxBackend, pollForExit } from "../../pi-extension/subagents/tmux.ts";
import {
  cleanupTestEnv, createTestEnv, createTrackedSurface, readScreen, readScreenAsync,
  sendCommand, sendLongCommand, sleep, uniqueId, waitForFile, waitForScreen, type TestEnv,
} from "./harness.ts";

function layout() {
  return JSON.parse(execFileSync("herdr", ["pane", "layout", "--pane", process.env.HERDR_PANE_ID!], {
    encoding: "utf8", timeout: 10_000,
  })).result.layout;
}

describe("Herdr surfaces", { skip: getMuxBackend() !== "herdr", timeout: 45_000 }, () => {
  let env: TestEnv;
  let first: string;
  let second: string;
  let originalFocus: string;

  before(async () => {
    env = createTestEnv();
    originalFocus = layout().focused_pane_id;
    first = createTrackedSurface(env, "herdr-check-a");
    second = createTrackedSurface(env, "herdr-check-b");
    await sleep(Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500"));
  });
  after(() => {
    cleanupTestEnv(env);
    const remaining = layout().panes.map((pane: any) => pane.pane_id);
    assert.ok(!remaining.includes(first) && !remaining.includes(second), "test panes should be closed");
  });

  it("creates two native panes below Pi, side by side, without changing focus", () => {
    const current = layout();
    const parent = current.panes.find((pane: any) => pane.pane_id === process.env.HERDR_PANE_ID);
    const a = current.panes.find((pane: any) => pane.pane_id === first);
    const b = current.panes.find((pane: any) => pane.pane_id === second);
    assert.equal(current.focused_pane_id, originalFocus);
    assert.ok(a.rect.y > parent.rect.y);
    assert.equal(a.rect.y, b.rect.y);
    assert.ok(b.rect.x > a.rect.x);
  });

  it("executes isolated commands in parallel and reads output sync/async", async () => {
    const marker = uniqueId();
    const pathA = join(env.dir, "a.txt");
    const pathB = join(env.dir, "b.txt");
    sendCommand(first, `printf 'A_'; printf '${marker}\\n'; pwd > '${pathA}'`);
    sendCommand(second, `printf 'B_'; printf '${marker}\\n'; pwd > '${pathB}'`);
    await Promise.all([
      waitForScreen(first, new RegExp(`A_${marker}`), 15_000),
      waitForScreen(second, new RegExp(`B_${marker}`), 15_000),
    ]);
    assert.equal((await waitForFile(pathA, 10_000)).trim(), process.cwd());
    assert.equal((await waitForFile(pathB, 10_000)).trim(), process.cwd());
    assert.ok(readScreen(first).includes(`A_${marker}`));
    assert.ok((await readScreenAsync(second)).includes(`B_${marker}`));
  });

  it("runs a long launch script and detects completion through the shared watcher", async () => {
    const marker = uniqueId();
    const scriptPath = join(env.dir, "launch script.sh");
    sendLongCommand(first, `printf '%s\\n' '${"X".repeat(500)}'; printf '__SUBAGENT_'; printf 'DONE_0__\\n'; printf '${marker}\\n'`, { scriptPath });
    await waitForScreen(first, new RegExp(marker), 15_000, 200);
    assert.deepEqual(await pollForExit(first, AbortSignal.timeout(10_000), { interval: 100 }), {
      reason: "sentinel", exitCode: 0,
    });
    assert.equal(layout().focused_pane_id, originalFocus);
  });
});

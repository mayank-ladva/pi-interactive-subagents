import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSurface, createSurface, createSurfaceSplit, getMuxBackend, isMuxAvailable,
  muxSetupHint, pollForExit, readScreen, readScreenAsync, sendCommand, sendLongCommand, sendMessage,
} from "../pi-extension/subagents/tmux.ts";

const envKeys = ["PATH", "TMUX", "TMUX_PANE", "HERDR_ENV", "HERDR_PANE_ID", "PI_MUX_TEST_DIR"];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
let dir: string;
const parent = { pane_id: "wTest:pMain", rect: { width: 180, height: 50 } };
const userPane = { pane_id: "wTest:pUser", rect: { width: 180, height: 50 } };

function state(panes: object[], extra: object = {}) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ panes, ...extra }));
}
function calls(): string[][] {
  return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-mux-test-"));
  const cli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PI_MUX_TEST_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const stateFile = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (path.basename(process.argv[1]) === 'tmux') {
  process.stdout.write('tmux screen');
  process.exit(0);
}
const op = args[1];
if (state.fail === op) { console.error('Herdr test failure'); process.exit(1); }
if (state.invalid === op) { console.log('{}'); process.exit(0); }
if (op === 'layout') console.log(JSON.stringify({result: {layout: {panes: state.panes}}}));
else if (op === 'split') {
  if (state.returnPane) {
    console.log(JSON.stringify({result: {pane: {pane_id: state.returnPane}}}));
    process.exit(0);
  }
  const pane_id = 'wTest:p' + ((state.counter || 0) + 1);
  state.counter = (state.counter || 0) + 1;
  state.panes.push({pane_id, rect: {width: 180, height: 25}});
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(JSON.stringify({result: {pane: {pane_id}}}));
} else if (op === 'read') process.stdout.write(state.screen || '');
else console.log(JSON.stringify({result: {type: 'ok'}}));
`;
  for (const binary of ["herdr", "tmux"]) {
    writeFileSync(join(dir, binary), cli, { mode: 0o755 });
  }
});

beforeEach(() => {
  process.env.PATH = `${dir}:${originalEnv.get("PATH")}`;
  process.env.PI_MUX_TEST_DIR = dir;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = parent.pane_id;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  writeFileSync(join(dir, "calls.jsonl"), "");
  state([parent, userPane]);
});

after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("multiplexer backend selection", () => {
  it("uses Herdr only inside a managed pane", () => {
    assert.equal(getMuxBackend(), "herdr");
    assert.equal(isMuxAvailable(), true);
    delete process.env.HERDR_PANE_ID;
    assert.equal(getMuxBackend(), null);
    assert.throws(() => createSurface("worker"), /supported multiplexer/);
    process.env.HERDR_PANE_ID = parent.pane_id;
    process.env.HERDR_ENV = "0";
    assert.equal(isMuxAvailable(), false);
    assert.match(muxSetupHint(), /Herdr.*tmux/);
    assert.deepEqual(calls(), []);
  });

  it("keeps tmux operations when nested inside tmux", async () => {
    process.env.TMUX = "/tmp/test-tmux,1,0";
    assert.equal(getMuxBackend(), "tmux");
    sendCommand("%2", "echo hello");
    assert.equal(readScreen("%2"), "tmux screen");
    assert.equal(await readScreenAsync("%2"), "tmux screen");
    assert.deepEqual(calls()[0], ["send-keys", "-t", "%2", "-l", "echo hello"]);
    assert.deepEqual(calls()[1], ["send-keys", "-t", "%2", "Enter"]);
    assert.ok(calls().slice(2).every((args) => args[0] === "capture-pane"));
    sendMessage("%2", "keep working");
    assert.deepEqual(calls().at(-2), ["send-keys", "-t", "%2", "-l", "keep working"]);
  });
});

describe("Herdr pane operations", () => {
  it("creates children below the parent then side by side without taking focus", () => {
    const first = createSurface("scout");
    const second = createSurface("worker");
    assert.notEqual(first, second);
    const splits = calls().filter((args) => args[1] === "split");
    assert.deepEqual(splits[0], [
      "pane", "split", "--pane", parent.pane_id, "--direction", "down",
      "--cwd", process.cwd(), "--no-focus",
    ]);
    assert.deepEqual(splits[1], [
      "pane", "split", "--pane", first, "--direction", "right",
      "--cwd", process.cwd(), "--no-focus",
    ]);
    closeSurface(first);
    closeSurface(second);
    assert.deepEqual(calls().slice(-2), [["pane", "close", first], ["pane", "close", second]]);
  });

  it("does not target a child that was manually closed", () => {
    const first = createSurface("scout");
    state([parent, userPane], { counter: 1 });
    const second = createSurface("worker");
    const split = calls().filter((args) => args[1] === "split").at(-1)!;
    assert.equal(split[split.indexOf("--pane") + 1], parent.pane_id);
    closeSurface(first);
    closeSurface(second);
  });

  it("splits a tall child down rather than making another narrow column", () => {
    const first = createSurface("scout");
    state([parent, userPane, { pane_id: first, rect: { width: 30, height: 40 } }], { counter: 1 });
    const second = createSurface("worker");
    const split = calls().filter((args) => args[1] === "split").at(-1)!;
    assert.equal(split[split.indexOf("--direction") + 1], "down");
    closeSurface(first);
    closeSurface(second);
  });

  it("splits the largest owned child instead of repeatedly shrinking the latest one", () => {
    const first = createSurface("scout");
    const second = createSurface("worker");
    state([
      parent, userPane,
      { pane_id: first, rect: { width: 180, height: 25 } },
      { pane_id: second, rect: { width: 40, height: 25 } },
    ], { counter: 2 });
    const third = createSurface("researcher");
    const split = calls().filter((args) => args[1] === "split").at(-1)!;
    assert.equal(split[split.indexOf("--pane") + 1], first);
    closeSurface(first);
    closeSurface(second);
    closeSurface(third);
  });

  it("forwards commands literally in one atomic submission and preserves long scripts", () => {
    const command = `printf '%s\\n' 'quotes $HOME; spaces'`;
    sendCommand("wTest:pChild", command);
    assert.deepEqual(calls()[0], ["pane", "run", "wTest:pChild", command]);
    const scriptPath = sendLongCommand("wTest:pChild", "echo " + "x".repeat(1000), {
      scriptPath: join(dir, "launch script.sh"),
    });
    assert.match(readFileSync(scriptPath, "utf8"), /x{1000}/);
    assert.deepEqual(calls()[1], ["pane", "run", "wTest:pChild", `bash '${scriptPath}'`]);
  });

  it("steers via the agent API without waiting and propagates blocked-agent errors", () => {
    sendMessage("wTest:pChild", "continue working");
    assert.deepEqual(calls()[0], ["agent", "prompt", "wTest:pChild", "continue working"]);
    state([parent], { fail: "prompt" });
    assert.throws(() => sendMessage("wTest:pChild", "continue"), /Herdr test failure/);
  });

  it("reads unwrapped output sync/async and detects a completion sentinel", async () => {
    state([parent], { screen: "__SUBAGENT_DONE_7__\n" });
    assert.equal(readScreen("wTest:pChild", 0), "__SUBAGENT_DONE_7__\n");
    assert.equal(await readScreenAsync("wTest:pChild", 5), "__SUBAGENT_DONE_7__\n");
    assert.deepEqual(calls()[0], ["pane", "read", "wTest:pChild", "--source", "recent-unwrapped", "--lines", "1"]);
    assert.deepEqual(await pollForExit("wTest:pChild", new AbortController().signal, { interval: 1 }), {
      reason: "sentinel", exitCode: 7,
    });
  });

  it("reports CLI failures instead of falling back to another pane or backend", async () => {
    state([parent], { fail: "split" });
    assert.throws(() => createSurface("worker"), /Herdr test failure/);
    state([parent], { fail: "read" });
    await assert.rejects(readScreenAsync("wTest:pChild", 5), /Herdr test failure/);
    assert.ok(calls().every((args) => args[0] === "pane"));
  });

  it("rejects malformed layout/split responses and unsupported directions", () => {
    state([parent], { invalid: "layout" });
    assert.throws(() => createSurface("worker"), /Invalid Herdr pane layout/);
    state([{ pane_id: "wTest:pMissingGeometry" }]);
    assert.throws(() => createSurface("worker"), /missing panes or geometry/);
    state([parent], { invalid: "split" });
    assert.throws(() => createSurfaceSplit("worker", "down"), /missing new pane ID/);
    assert.throws(() => createSurfaceSplit("worker", "left"), /support right\/down/);
    state([parent, userPane], { returnPane: userPane.pane_id });
    assert.throws(() => createSurface("worker"), /existing pane ID/);
    state([parent, userPane], { returnPane: parent.pane_id });
    assert.throws(() => createSurfaceSplit("worker", "right", "wTest:pChild"), /missing new pane ID/);
    assert.ok(calls().every((args) => args[1] !== "close"));
  });
});

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_OPTIONS = { encoding: "utf8" as const, timeout: 10_000 };
const subagentPanes = new Set<string>();

type Direction = "left" | "right" | "up" | "down";
type Pane = { pane_id: string; rect: { width: number; height: number } };

function requireHerdr(): string {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("Herdr subagents require Pi to run inside a Herdr-managed pane.");
  }
  return process.env.HERDR_PANE_ID;
}

function run(args: string[]): string {
  requireHerdr();
  return execFileSync("herdr", ["pane", ...args], CLI_OPTIONS);
}

export function createSurface(name: string): string {
  const parent = requireHerdr();
  const layout = JSON.parse(run(["layout", "--pane", parent])).result?.layout;
  if (
    !Array.isArray(layout?.panes) ||
    !layout.panes.every(
      (pane: Pane) =>
        typeof pane?.pane_id === "string" &&
        pane.pane_id.length > 0 &&
        Number.isFinite(pane.rect?.width) &&
        pane.rect.width > 0 &&
        Number.isFinite(pane.rect?.height) &&
        pane.rect.height > 0,
    )
  ) {
    throw new Error("Invalid Herdr pane layout response: missing panes or geometry.");
  }

  // Only split our own children; never reuse the user's other panes.
  const children = (layout.panes as Pane[]).filter((pane) => subagentPanes.has(pane.pane_id));
  const target = children.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  const direction = !target || target.rect.width <= target.rect.height * 2 ? "down" : "right";
  const pane = createSurfaceSplit(name, direction, target?.pane_id ?? parent);
  if (layout.panes.some((existing: Pane) => existing.pane_id === pane)) {
    throw new Error("Invalid Herdr pane split response: returned an existing pane ID.");
  }
  subagentPanes.add(pane);
  return pane;
}

export function createSurfaceSplit(name: string, direction: Direction, fromSurface?: string): string {
  void name; // Pi sets its own title once the child starts.
  const parent = requireHerdr();
  if (direction !== "right" && direction !== "down") {
    throw new Error(`Herdr pane splits support right/down, not ${direction}.`);
  }
  const response = JSON.parse(
    run(["split", "--pane", fromSurface ?? parent, "--direction", direction, "--cwd", process.cwd(), "--no-focus"]),
  );
  const pane = response.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane || pane === parent || pane === fromSurface) {
    throw new Error("Invalid Herdr pane split response: missing new pane ID.");
  }
  return pane;
}

export function sendCommand(surface: string, command: string): void {
  run(["run", surface, command]);
}

export function sendMessage(surface: string, message: string): void {
  requireHerdr();
  execFileSync("herdr", ["agent", "prompt", surface, message], CLI_OPTIONS);
}

export function readScreen(surface: string, lines: number): string {
  return run(["read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))]);
}

export async function readScreenAsync(surface: string, lines: number): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    CLI_OPTIONS,
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  run(["close", surface]);
  subagentPanes.delete(surface);
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __test__ } from "../pi-extension/subagents/index.ts";

const MODEL = "kilocode/nvidia/nemotron-3-ultra-550b-a55b:free";
const PROVIDER = "~/.pi/agent/npm/node_modules/pi-kilocode/src/index.ts";

describe("bundled Kilo profiles", () => {
  for (const name of ["scout", "researcher", "worker"]) {
    it(`${name} uses the upstream child-only extension mechanism`, () => {
      const profile = __test__.parseAgentDefinition(
        readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8"),
        name,
      );
      assert.ok(profile);
      assert.equal(profile.model, MODEL);
      assert.deepEqual(profile.subagentOnlyExtensions, [PROVIDER]);
      assert.equal(profile.explicitLoadout, false);
      assert.equal(profile.fallbackModel, "pi-default");
    });
  }
});

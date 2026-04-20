import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3 } from "../src/validation/index.js";

test("validation layers are exported as functions", () => {
  assert.equal(typeof runLayer1, "function");
  assert.equal(typeof runLayer2, "function");
  assert.equal(typeof runLayer3, "function");
});

test("runLayer1 rejects until implemented", async () => {
  await assert.rejects(
    runLayer1({ projectDir: "/tmp", forbiddenTokens: [] }),
    /not implemented/i,
  );
});

test("runLayer2 rejects until implemented", async () => {
  await assert.rejects(
    runLayer2({ railsDir: "/tmp" }),
    /not implemented/i,
  );
});

test("runLayer3 rejects until implemented", async () => {
  await assert.rejects(
    runLayer3({
      screenshotPath: "/tmp/x.png",
      rubric: [],
      spec: "",
    }),
    /not implemented/i,
  );
});

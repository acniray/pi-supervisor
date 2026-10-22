import test from "node:test";
import assert from "node:assert/strict";
import index from "./index.ts";

test("index default export is a function", () => {
  assert.equal(typeof index, "function");
});

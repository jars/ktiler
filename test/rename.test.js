import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createState, isValidState } from "../engine.js";
import { createSimulatorState } from "../simulator.js";

test("the renamed simulator preserves legacy storage and prefers its new key", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const declarations = source.match(/^const (?:STORAGE_KEY|LEGACY_STORAGE_KEY) = .*;$/gm).join("\n");
  const loader = source.slice(source.indexOf("function loadState()"), source.indexOf("function saveState()"));
  const legacy = createState();
  legacy.displays[0].mode = "horizontal";
  const current = createState();
  current.spreadResize = false;
  const storage = new Map([["kdetiler-simulator-v1", JSON.stringify({ version: 1, state: legacy })]]);
  const load = () => JSON.parse(JSON.stringify(vm.runInNewContext(`${declarations}\n${loader}\nloadState()`, {
    localStorage: { getItem: (key) => storage.get(key) ?? null }, createSimulatorState, isValidState,
  })));
  assert.deepEqual(load(), legacy);
  storage.set("ktiler-simulator-v1", JSON.stringify({ version: 1, state: current }));
  assert.deepEqual(load(), { ...current, spreadResize: true });
  storage.clear();
  assert.deepEqual(load(), createSimulatorState());
});

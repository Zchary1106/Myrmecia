import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { convert } from "../src/tempconvert.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);
const cliEntryPath = resolve(currentDirPath, "../src/tempconvert.ts");

test("converts Celsius to Fahrenheit", () => {
  assert.equal(convert(0, "C", "F"), 32);
});

test("converts Fahrenheit to Celsius", () => {
  assert.equal(convert(32, "F", "C"), 0);
});

test("converts Celsius to Kelvin", () => {
  assert.equal(convert(100, "C", "K"), 373.15);
});

test("converts Kelvin to Celsius", () => {
  assert.equal(convert(273.15, "K", "C"), 0);
});

test("converts Fahrenheit to Kelvin", () => {
  assert.equal(convert(32, "F", "K"), 273.15);
});

test("returns the original value for identity conversion", () => {
  assert.equal(convert(25.12, "C", "C"), 25.12);
});

test("rounds to at most 2 decimals", () => {
  assert.equal(convert(1, "F", "C"), -17.22);
});

test("throws RangeError for values below absolute zero in the source unit", () => {
  assert.throws(() => convert(-274, "C", "F"), RangeError);
  assert.throws(() => convert(-500, "F", "C"), RangeError);
  assert.throws(() => convert(-1, "K", "C"), RangeError);
});

test("CLI --help prints usage text", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliEntryPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tempconvert <value> <from> <to>/);
  assert.equal(result.stderr, "");
});

test("CLI prints converted value on success", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliEntryPath, "100", "c", "f"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "212");
  assert.equal(result.stderr, "");
});

#!/usr/bin/env node
// Validator for Geothermal Power mod datasets.
// Builds on the Coal Power pattern (raw + block + cross-reference) and adds:
//   (a) BASE-GAME FLUIDS/GASES LOADING — first mod to need this. The Geothermal
//       Well 2.5 m declares `fuel.consumesId: "water"`, so the validator loads
//       ids from base-game's data/fluids.json and data/gases.json into the
//       known-ids universe. Other fluid/gas-consuming mods should adopt this.
//   (b) SIBLING-MOD CROSS-REFERENCE — the Magma Tap 5 m's buildComponents
//       reach into Chemistry & Plastics's `composite_plastic`. Loaded via
//       CHEMISTRY_PLASTICS_REPO env var with the same graceful-skip pattern
//       as BASE_GAME_REPO (precedent: Chemistry & Plastics itself loads
//       Forestry + Petroleum Power this way).
//   (c) ALSO LOADS THIS MOD'S OWN fluids.json into localItemIds — `lava` is a
//       local fluid id that may appear in block records' consumedBy lists or
//       future fuel.consumesId fields. Treated the same as other local ids.
//
// Cross-reference scope:
//   1. JSON Schema validation (envelope, index, raw, fluid-gas, block).
//   2. Cross-reference: every buildComponents id, producesIds entry, and
//      fuel.consumesId must resolve to a base-game id, a sibling-mod id,
//      or a local id defined in this mod.
//   3. Cross-reference: every raw resource's `refinableInto[]` entry must
//      match a base-game refinery-product displayName or a local item
//      displayName.
//
// Env overrides (all optional, default to sibling directory lookup):
//   BASE_GAME_REPO            — path to space-engineer-2-base-game
//   CHEMISTRY_PLASTICS_REPO   — path to space-engineer-2-chemistry-plastics

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
const loadAbs = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats.default(ajv);

const envelopeSchema = load("schemas/envelope.schema.json");
const indexSchema = load("schemas/index.schema.json");
const rawSchema = load("schemas/resource-raw.schema.json");
const fluidGasSchema = load("schemas/resource-fluid-gas.schema.json");
const blockSchema = load("schemas/resource-block.schema.json");

const validateEnvelope = ajv.compile(envelopeSchema);
const validateIndex = ajv.compile(indexSchema);
const validateRaw = ajv.compile(rawSchema);
const validateFluidGas = ajv.compile(fluidGasSchema);
const validateBlock = ajv.compile(blockSchema);

const index = load("index.json");

// Cross-reference universes.
const baseRepoPath =
  process.env.BASE_GAME_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-base-game");
const chemistryPlasticsRepoPath =
  process.env.CHEMISTRY_PLASTICS_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-chemistry-plastics");

let baseLoaded = false;
const baseRawIds = new Set();
const baseItemIds = new Set();
const baseItemDisplayNames = new Set();
const baseBlockDisplayNames = new Set();

const baseRawPath = resolve(baseRepoPath, "data/raw-resources.json");
const baseBlocksDir = resolve(baseRepoPath, "data/blocks");

if (existsSync(baseRawPath)) {
  const baseRaw = loadAbs(baseRawPath);
  for (const r of baseRaw.resources) baseRawIds.add(r.id);

  const itemFiles = [
    "data/components/simple.json",
    "data/components/complex.json",
    "data/components/high-tech.json",
    "data/refinery-products.json",
    "data/character-gear.json",
    "data/ammunition.json",
    // First mod to also load fluids + gases. `fuel.consumesId: "water"` on
    // the Geothermal Well needs `water` in the known-ids set. Bucketed into
    // baseItemIds alongside other non-raw ids — the validator doesn't need
    // to distinguish them downstream.
    "data/fluids.json",
    "data/gases.json",
  ];
  for (const rel of itemFiles) {
    const abs = resolve(baseRepoPath, rel);
    if (!existsSync(abs)) continue;
    const doc = loadAbs(abs);
    for (const r of doc.resources) {
      baseItemIds.add(r.id);
      if (r.displayName) baseItemDisplayNames.add(r.displayName);
    }
  }

  const walkBlocks = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walkBlocks(p);
      else if (name.endsWith(".json")) {
        const doc = loadAbs(p);
        for (const r of doc.resources ?? []) {
          if (r.displayName) baseBlockDisplayNames.add(r.displayName);
          if (r.id) baseItemIds.add(r.id);
        }
      }
    }
  };
  walkBlocks(baseBlocksDir);

  baseLoaded = true;
  console.log(
    `✓ base-game cross-ref loaded: ${baseRawIds.size} raw ids, ${baseItemIds.size} item/block/fluid/gas ids, ${baseBlockDisplayNames.size} block displayNames`,
  );
} else {
  console.warn(
    `! base-game repo not found at ${baseRepoPath} — skipping cross-reference checks (set BASE_GAME_REPO to enable)`,
  );
}

// Sibling-mod loading. Each sibling contributes raw ids, item ids, item
// displayNames, and block displayNames into the known-ids universe.
const siblingRawIds = new Set();
const siblingItemIds = new Set();
const siblingItemDisplayNames = new Set();
const siblingBlockDisplayNames = new Set();

const loadSiblingMod = (label, path) => {
  const indexPath = resolve(path, "index.json");
  if (!existsSync(indexPath)) {
    console.warn(
      `! ${label} mod not found at ${path} — skipping sibling-mod cross-reference (set the matching env var to enable)`,
    );
    return;
  }
  const siblingIndex = loadAbs(indexPath);
  for (const entry of siblingIndex.datasets ?? []) {
    const abs = resolve(path, entry.path);
    if (!existsSync(abs)) continue;
    const doc = loadAbs(abs);
    for (const r of doc.resources ?? []) {
      if (!r?.id) continue;
      if (entry.id === "raw-resources") {
        siblingRawIds.add(r.id);
      } else if (entry.id.startsWith("blocks-")) {
        if (r.displayName) siblingBlockDisplayNames.add(r.displayName);
      } else {
        siblingItemIds.add(r.id);
        if (r.displayName) siblingItemDisplayNames.add(r.displayName);
      }
    }
  }
  console.log(
    `✓ ${label} sibling-mod cross-ref loaded from ${indexPath}`,
  );
};

if (baseLoaded) {
  loadSiblingMod("Chemistry & Plastics", chemistryPlasticsRepoPath);
}

// Well-known non-block producers used across vanilla.
const nonBlockProducers = new Set(["Backpack Building"]);

// Local ids tracked across this mod's datasets.
const localRawIds = new Set();
const localItemIds = new Set();
const localItemDisplayNames = new Set();
const localBlockDisplayNames = new Set();

let failures = 0;
const report = (label, errors) => {
  if (!errors || errors.length === 0) return;
  failures += errors.length;
  console.error(`✗ ${label}`);
  for (const err of errors) {
    console.error(`    ${err.instancePath || "(root)"} ${err.message}`);
    if (err.params && Object.keys(err.params).length) {
      console.error(`      params: ${JSON.stringify(err.params)}`);
    }
  }
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failures += 1;
};

const recordKindFor = (datasetId) => {
  if (datasetId === "raw-resources") return { kind: "raw", fn: validateRaw };
  if (datasetId === "fluids" || datasetId === "gases") return { kind: "fluid-gas", fn: validateFluidGas };
  if (datasetId.startsWith("blocks-")) return { kind: "block", fn: validateBlock };
  throw new Error(`Unknown dataset id: ${datasetId}`);
};

if (!validateIndex(index)) {
  report("index.json", validateIndex.errors);
} else {
  console.log("✓ index.json");
}

// First pass: schema + envelope validation. Collect local ids.
const perDatasetRecords = new Map();
for (const entry of index.datasets) {
  const data = load(entry.path);
  const label = entry.path;

  if (!validateEnvelope(data)) {
    report(`${label} (envelope)`, validateEnvelope.errors);
    continue;
  }

  const { kind, fn } = recordKindFor(entry.id);
  let recordFailures = 0;
  for (const [i, rec] of data.resources.entries()) {
    const recLabel = `${label} [${i}] ${kind} record "${rec.id ?? "?"}"`;
    if (!fn(rec)) {
      recordFailures += fn.errors.length;
      report(recLabel, fn.errors);
    } else {
      if (kind === "raw") localRawIds.add(rec.id);
      if (kind === "fluid-gas") {
        // Fluids/gases behave like items for cross-reference — anything with
        // an id goes into the known-ids set so downstream blocks (this mod
        // or others) can fuel.consumesId against lava/water/etc.
        localItemIds.add(rec.id);
        if (rec.displayName) localItemDisplayNames.add(rec.displayName);
      }
      if (kind === "block" && rec.displayName) {
        localBlockDisplayNames.add(rec.displayName);
      }
    }
  }

  if (data.resources.length !== entry.entryCount) {
    fail(
      `${label} — index declares ${entry.entryCount} entries but file has ${data.resources.length}`,
    );
  }
  if (recordFailures === 0) {
    console.log(`✓ ${label} (${data.resources.length} ${kind} records)`);
  }
  perDatasetRecords.set(entry.id, data.resources);
}

// Second pass: cross-reference checks (only if base-game data is loaded).
if (baseLoaded) {
  const ids = new Set([
    ...baseRawIds,
    ...baseItemIds,
    ...siblingRawIds,
    ...siblingItemIds,
    ...localRawIds,
    ...localItemIds,
  ]);
  const itemDisplayNames = new Set([
    ...baseItemDisplayNames,
    ...siblingItemDisplayNames,
    ...localItemDisplayNames,
  ]);

  // Raw records: check refinableInto[] entries.
  const rawRecs = perDatasetRecords.get("raw-resources") ?? [];
  for (const rec of rawRecs) {
    const label = `data/raw-resources.json record "${rec.id}"`;
    for (const [i, target] of (rec.refinableInto ?? []).entries()) {
      if (!itemDisplayNames.has(target)) {
        fail(
          `${label} — refinableInto[${i}] "${target}" does not match any base-game refinery-product or local item displayName`,
        );
      }
    }
  }

  // Blocks: check buildComponents[].id, production.producesIds[], fuel.consumesId.
  for (const [datasetId, recs] of perDatasetRecords.entries()) {
    if (!datasetId.startsWith("blocks-")) continue;
    const entry = index.datasets.find((d) => d.id === datasetId);
    for (const rec of recs) {
      const label = `${entry.path} record "${rec.id}"`;
      for (const [ci, comp] of rec.buildComponents.entries()) {
        if (!ids.has(comp.id)) {
          fail(
            `${label} — buildComponents[${ci}].id "${comp.id}" is not a base-game, sibling-mod, or local raw/item/fluid/gas id`,
          );
        }
      }
      const pIds = rec.production?.producesIds ?? [];
      for (const [pi, pid] of pIds.entries()) {
        if (!ids.has(pid)) {
          fail(
            `${label} — production.producesIds[${pi}] "${pid}" is not a base-game, sibling-mod, or local raw/item/fluid/gas id`,
          );
        }
      }
      const fuelId = rec.fuel?.consumesId;
      if (fuelId && !ids.has(fuelId)) {
        fail(
          `${label} — fuel.consumesId "${fuelId}" is not a base-game, sibling-mod, or local raw/item/fluid/gas id`,
        );
      }
    }
  }

  // totalEntries sanity.
  const sumEntries = index.datasets.reduce((a, d) => a + d.entryCount, 0);
  if (index.totalEntries !== sumEntries) {
    fail(
      `index.json — totalEntries declares ${index.totalEntries} but dataset entryCount sum is ${sumEntries}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation error(s)`);
  process.exit(1);
}
console.log("\nAll datasets valid.");

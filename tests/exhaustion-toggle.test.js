import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { MODULE_ID } from "../scripts/lib/identifier.js";
import { effectExhaustionLevel, exhaustionEnabled, initializeExhaustionMode, registerExhaustionSettings } from "../scripts/exhaustion/config.js";
import { initExhaustion, refreshExhaustion } from "../scripts/exhaustion/index.js";
import { setExhaustion } from "../scripts/exhaustion/effects.js";
import { addExhaustionToRoll } from "../scripts/exhaustion/rolls.js";
import { configureExhaustionRules, configureTidyExhaustion } from "../scripts/exhaustion/sheets.js";

const clone = value => JSON.parse(JSON.stringify(value));
let values, registered, hooks, writes;
class Field { constructor(options) { this.options = options; } }
globalThis.foundry = { data: { fields: { NumberField: Field, StringField: Field } } };
globalThis.Hooks = {
  on(name) { hooks.push(name); }, once(name) { hooks.push(name); }
};
beforeEach(() => {
  hooks = []; writes = [];
  values = new Map([
    [`${MODULE_ID}.exhaustionEnabled`, true], [`${MODULE_ID}.exhaustionMaxLevel`, 10],
    [`${MODULE_ID}.exhaustionPenaltyPerLevel`, 1], [`${MODULE_ID}.exhaustionPenaltyTable`, ""],
    ["tidy5e-sheet.exhaustionConfig", { type: "specific", levels: 6, hints: [] }],
    ["tidy5e-sheet.useExhaustion", false]
  ]);
  registered = new Map();
  globalThis.CONFIG = {
    Actor: { documentClass: class {} }, ActiveEffect: { documentClass: class {} },
    DND5E: { conditionTypes: { exhaustion: { levels: 6, reduction: { rolls: 2, speed: 5 } } }, conditionEffects: { halfHealth: new Set(["exhaustion-4"]) } }
  };
  globalThis.game = {
    ready: true, user: { id: "gm" }, users: { activeGM: { id: "gm" } }, actors: [], scenes: [], packs: new Map(),
    modules: new Map([["tidy5e-sheet", { active: true }]]),
    settings: {
      settings: new Map([["tidy5e-sheet.exhaustionConfig", { default: { type: "specific", levels: 6, hints: [] } }]]),
      register(scope, key, config) { registered.set(`${scope}.${key}`, config); },
      get(scope, key) { return values.has(`${scope}.${key}`) ? values.get(`${scope}.${key}`) : registered.get(`${scope}.${key}`)?.default; },
      async set(scope, key, value) { writes.push(`${scope}.${key}`); values.set(`${scope}.${key}`, clone(value)); }
    }
  };
  initializeExhaustionMode();
});
function mode(enabled) {
  values.set(`${MODULE_ID}.exhaustionEnabled`, enabled);
  initializeExhaustionMode(); // A new page load starts a new mode.
}

test("world toggle defaults to enabled and requires reload; settings remain available when disabled", () => {
  registerExhaustionSettings(() => {});
  const setting = registered.get(`${MODULE_ID}.exhaustionEnabled`);
  assert.equal(setting.type, Boolean); assert.equal(setting.default, true);
  assert.equal(setting.scope, "world"); assert.equal(setting.config, true); assert.equal(setting.requiresReload, true);
  assert.equal(exhaustionEnabled(), true);
  values.set(`${MODULE_ID}.exhaustionEnabled`, false);
  assert.equal(exhaustionEnabled(), true); // Saving the setting cannot half-switch the running session.
  initExhaustion();
  assert.equal(exhaustionEnabled(), false);
  assert.ok(registered.has(`${MODULE_ID}.exhaustionPenaltyTable`));
  assert.deepEqual(hooks, []); // No custom system, effect or roll hooks are installed.
  assert.equal(CONFIG.Actor.documentClass.prototype.addRollExhaustion, undefined);
});

test("enabled initialization installs the exhaustion setup and Tidy integration", () => {
  initExhaustion();
  assert.deepEqual(hooks, ["tidy5e-sheet.ready", "setup"]);
});

test("disabled mode leaves native rules and native exhaustion roll terms intact", () => {
  mode(false);
  configureExhaustionRules();
  assert.deepEqual(CONFIG.DND5E.conditionTypes.exhaustion, { levels: 6, reduction: { rolls: 2, speed: 5 } });
  assert.equal(CONFIG.DND5E.conditionEffects.halfHealth.has("exhaustion-4"), true);
  const parts = ["@mod", "@exhaustion"], data = { mod: 3, exhaustion: -4 };
  addExhaustionToRoll({ system: { attributes: { exhaustion: 2 } } }, parts, data);
  assert.deepEqual(parts, ["@mod", "@exhaustion"]); assert.deepEqual(data, { mod: 3, exhaustion: -4 });
});

test("disabled refresh does not modify actors or the compendium, and preserves custom penalty settings", async () => {
  mode(false);
  game.actors = [{ get uuid() { throw new Error("Actors must not be modified"); } }];
  game.packs = { get() { throw new Error("Compendium must not be modified"); } };
  await refreshExhaustion();
  assert.equal(values.get(`${MODULE_ID}.exhaustionMaxLevel`), 10);
  assert.equal(values.get(`${MODULE_ID}.exhaustionPenaltyPerLevel`), 1);
  assert.deepEqual(writes, []);
});

test("disabled API delegates to the native actor update and native level limit", async () => {
  mode(false);
  const updates = [];
  const actor = { documentName: "Actor", type: "character", isOwner: true,
    async update(changes) { updates.push(changes); return this; } };
  await setExhaustion(actor, 9); await setExhaustion(actor, 2); await setExhaustion(actor, 0);
  assert.deepEqual(updates, [6, 2, 0].map(level => ({ "system.attributes.exhaustion": level })));
});

test("Tidy configuration is backed up once, restored on disable, and can be enabled again", async () => {
  const original = { type: "open" };
  values.set("tidy5e-sheet.exhaustionConfig", original);
  await configureTidyExhaustion();
  assert.equal(values.get("tidy5e-sheet.exhaustionConfig").levels, 10);
  assert.equal(values.get("tidy5e-sheet.useExhaustion"), true);
  const before = writes.length; await configureTidyExhaustion(); assert.equal(writes.length, before);
  mode(false); await configureTidyExhaustion();
  assert.deepEqual(values.get("tidy5e-sheet.exhaustionConfig"), original);
  assert.equal(values.get("tidy5e-sheet.useExhaustion"), false);
  assert.deepEqual(values.get(`${MODULE_ID}.exhaustionTidyBackup`), {});
  const restored = writes.length; await configureTidyExhaustion(); assert.equal(writes.length, restored);
  mode(true); await configureTidyExhaustion();
  assert.equal(values.get("tidy5e-sheet.exhaustionConfig").levels, 10);
});

test("disabling an older installation clears managed Tidy hints without overwriting unrelated configurations", async () => {
  mode(false);
  values.set("tidy5e-sheet.exhaustionConfig", { type: "specific", levels: 10,
    hints: ["Нет истощения", "Истощение 1: −1 ко всем броскам d20."] });
  await configureTidyExhaustion();
  assert.deepEqual(values.get("tidy5e-sheet.exhaustionConfig"), { type: "specific", levels: 6, hints: [] });
  values.set("tidy5e-sheet.exhaustionConfig", { type: "specific", levels: 8, hints: ["Другая система"] });
  await configureTidyExhaustion();
  assert.equal(values.get("tidy5e-sheet.exhaustionConfig").levels, 8);
});

test("native effect edits while disabled take precedence over stale module flags on re-enable", () => {
  assert.equal(effectExhaustionLevel({ flags: { dnd5e: { exhaustionLevel: 2 }, [MODULE_ID]: { exhaustionLevel: 8 } } }), 2);
});

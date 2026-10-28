import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MODULE_ID } from "../scripts/lib/identifier.js";
import {
  clampExhaustion, exhaustionConfig, exhaustionPenalty, exhaustionEffectData,
  parsePenaltyTable, registerExhaustionSettings, ROLL_KEY, ROLL_PART, SYNC_OPTION
} from "../scripts/exhaustion/config.js";
import { registerExhaustionEffects, setExhaustion, reconcileExhaustionActors } from "../scripts/exhaustion/effects.js";
import { addExhaustionToRoll, registerExhaustionRolls } from "../scripts/exhaustion/rolls.js";
import { configureExhaustionRules, configureTidyExhaustion, registerExhaustionSheets } from "../scripts/exhaustion/sheets.js";
import { exhaustionPresetData, ensureExhaustionPack, EXHAUSTION_FOLDER_ID } from "../scripts/exhaustion/compendium.js";

const clone = value => JSON.parse(JSON.stringify(value));
const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function put(object, path, value) {
  const keys = path.split(".");
  const final = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[final] = value;
}
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (key.includes(".")) put(target, key, clone(value));
    else if (value && !Array.isArray(value) && typeof value === "object") merge(target[key] ??= {}, value);
    else target[key] = clone(value);
  }
  return target;
}
class Collection extends Map {
  [Symbol.iterator]() { return this.values(); }
}
const handlers = new Map();
globalThis.Hooks = {
  on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
  call(name, ...args) { for (const fn of handlers.get(name) ?? []) if (fn(...args) === false) return false; return true; }
};
class MockEffect {
  static ID = { EXHAUSTION: "dnd5eExhaustion1" };
  constructor(data, actor) { this.parent = actor; this.updateSource(data); }
  updateSource(data) {
    this._source = merge(this._source ?? {}, data);
    Object.assign(this, clone(this._source));
    this.id = this._source._id;
    this.statuses = new Set(this._source.statuses ?? []);
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  toObject() { return clone(this._source); }
}
let nextId = 0;
class MockActor {
  constructor(level = 0) {
    this.documentName = "Actor"; this.type = "character"; this.isOwner = true;
    this.uuid = `Actor.test${nextId++}`; this.effects = new Collection(); this.items = new Collection();
    this._source = { system: { attributes: { exhaustion: level } } }; this.operations = [];
    this.system = clone(this._source.system);
  }
  prepare() {
    const effect = this.effects.get(MockEffect.ID.EXHAUSTION);
    // Mirrors CommonTemplate.prepareExhaustionLevel in installed dnd5e 5.3.3.
    const level = effect?.getFlag("dnd5e", "exhaustionLevel");
    this.system = clone(this._source.system);
    this.system.attributes.exhaustion = Number.isFinite(level) ? level : 0;
  }
  async update(changes, options = {}) {
    Hooks.call("preUpdateActor", this, changes, options, game.user.id);
    merge(this._source, changes); this.prepare();
    void this._onUpdateExhaustion(changes, options);
    this.operations.push(["actor", clone(changes)]);
    return this;
  }
  async createEmbeddedDocuments(type, entries, options = {}) {
    const created = [];
    for (const entry of entries) {
      const data = { ...clone(entry), _id: options.keepId ? entry._id : `random${nextId++}` };
      const doc = type === "Item" ? { ...data, parent: this } : new MockEffect(data, this);
      if (Hooks.call(`preCreate${type}`, doc, data, options, game.user.id) === false) continue;
      (type === "Item" ? this.items : this.effects).set(doc.id ?? data._id, doc);
      this.prepare(); this.operations.push(["create", data._id]); created.push(doc);
      Hooks.call(`create${type}`, doc, options, game.user.id);
      // dnd5e 5.3.3 Actor5e._onCreateDescendantDocuments also writes the source level.
      if (type === "ActiveEffect" && doc.id === MockEffect.ID.EXHAUSTION
        && !this._source.system.attributes.exhaustion) await this.update({ "system.attributes.exhaustion": 1 });
    }
    return created;
  }
  async updateEmbeddedDocuments(type, entries, options = {}) {
    for (const data of entries) {
      const effect = this.effects.get(data._id);
      Hooks.call(`preUpdate${type}`, effect, data, options, game.user.id);
      effect.updateSource(data); this.prepare(); this.operations.push(["update", data._id]);
      Hooks.call(`update${type}`, effect, data, options, game.user.id);
    }
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    for (const id of ids) {
      const effect = this.effects.get(id); this.effects.delete(id); this.prepare();
      this.operations.push(["delete", id]); Hooks.call(`delete${type}`, effect, options, game.user.id);
      if (type === "ActiveEffect" && id === MockEffect.ID.EXHAUSTION) {
        await this.update({ "system.attributes.exhaustion": 0 });
      }
    }
  }
}
globalThis.CONFIG = {
  Actor: { documentClass: MockActor }, ActiveEffect: { documentClass: MockEffect },
  Dice: { BasicRoll: { replaceFormulaData: (formula, data) => formula.replace(/@([A-Za-z]+)/g, (_match, key) => data[key] ?? "0") } },
  DND5E: { conditionTypes: { exhaustion: {} }, conditionEffects: {} }
};
class MockField { constructor(options) { this.options = options; } }
globalThis.foundry = {
  utils: { getProperty: get, setProperty: put, mergeObject: merge },
  data: { fields: { NumberField: MockField, StringField: MockField } }
};
globalThis.ui = { notifications: { error(message) { throw new Error(message); } } };
registerExhaustionEffects();
registerExhaustionRolls();
registerExhaustionSheets();
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
let settings;
beforeEach(() => {
  settings = new Map([
    [`${MODULE_ID}.exhaustionMaxLevel`, 10], [`${MODULE_ID}.exhaustionPenaltyPerLevel`, 1],
    [`${MODULE_ID}.exhaustionPenaltyTable`, ""], ["tidy5e-sheet.useExhaustion", true],
    ["tidy5e-sheet.exhaustionConfig", { type: "specific", levels: 6, hints: [] }]
  ]);
  globalThis.game = {
    user: { id: "gm" }, users: { activeGM: { id: "gm" } },
    settings: { get: (scope, key) => settings.get(`${scope}.${key}`),
      set: async (scope, key, value) => settings.set(`${scope}.${key}`, value) },
    actors: [], scenes: [], modules: new Map(), packs: new Map()
  };
});
const changeSetting = (key, value) => settings.set(`${MODULE_ID}.${key}`, value);
const condition = actor => actor.effects.get(MockEffect.ID.EXHAUSTION);

test("defaults: ten levels, fifth level subtracts five, zero removes penalty", () => {
  assert.deepEqual(exhaustionConfig(), { maxLevel: 10, perLevel: 1, penalties: [] });
  assert.equal(exhaustionPenalty(5), 5); assert.equal(exhaustionPenalty(0), 0);
  assert.equal(clampExhaustion(15), 10); assert.equal(clampExhaustion(-2), 0);
});

test("custom penalty table is cumulative, supports zero/fractions, falls back per level", () => {
  changeSetting("exhaustionPenaltyPerLevel", 2);
  changeSetting("exhaustionPenaltyTable", "0; 1.5; 4; 6; 8");
  assert.equal(exhaustionPenalty(1), 0); assert.equal(exhaustionPenalty(2), 1.5);
  assert.equal(exhaustionPenalty(5), 8); assert.equal(exhaustionPenalty(6), 12);
  assert.equal(parsePenaltyTable("1; -2"), null); assert.equal(parsePenaltyTable("1; wrong"), null);
});

test("settings reject negative per-level penalties and malformed tables", () => {
  const registered = new Map(); game.settings.register = (_scope, key, data) => registered.set(key, data);
  registerExhaustionSettings(() => {});
  assert.equal(registered.get("exhaustionPenaltyPerLevel").type.options.min, 0);
  const validate = registered.get("exhaustionPenaltyTable").type.options.validate;
  assert.equal(validate(""), true); assert.equal(validate("1; 2.5; 0"), true);
  assert.equal(validate("1; -3"), false);
});

test("d20 formula has exactly one labelled penalty, with advantage and immunity", () => {
  const actor = new MockActor(); actor.system.attributes.exhaustion = 5;
  actor.system.traits = { ci: { value: new Set(["exhaustion"]) } };
  const parts = ["@mod"], data = { mod: 3 };
  actor.addRollExhaustion(parts, data); actor.addRollExhaustion(parts, data);
  assert.deepEqual(parts, ["@mod", ROLL_PART]); assert.equal(data[ROLL_KEY], -5);
  const process = { subject: { actor }, hookNames: ["attack", "d20Test"] };
  const config = { parts, data, options: { advantageMode: 1 } };
  Hooks.call("dnd5e.postBuildD20TestRollConfig", process, config);
  assert.equal(parts.filter(p => p === ROLL_PART).length, 1); assert.equal(config.options.advantageMode, 1);
  actor.system.attributes.exhaustion = 0; addExhaustionToRoll(actor, parts, data);
  assert.deepEqual(parts, ["@mod"]); assert.equal(data[ROLL_KEY], undefined);
});

test("flat attack and secondary rolls obtain the actor penalty from the roll hook", () => {
  const actor = new MockActor(); actor.system.attributes.exhaustion = 5;
  for (const subject of [actor, { actor }]) {
    const config = { parts: ["7"], data: {} };
    Hooks.call("dnd5e.postBuildD20TestRollConfig", { subject }, config);
    assert.deepEqual(config.parts, ["7", ROLL_PART]); assert.equal(config.data[ROLL_KEY], -5);
  }
});

test("utility d20 formulas apply exhaustion, ordinary utility dice do not", () => {
  const actor = new MockActor(); actor.system.attributes.exhaustion = 5;
  for (const formula of ["1d20 + 3", "2d20kh + 3", "@die + 3"]) {
    const config = { parts: [formula], data: { die: "1d20" } };
    Hooks.call("dnd5e.postBuildFormulaRollConfig", { subject: { actor } }, config);
    assert.equal(config.data[ROLL_KEY], -5);
  }
  for (const formula of ["1d8 + 3", "1d200 + 3"]) {
    const config = { parts: [formula], data: {} };
    Hooks.call("dnd5e.postBuildFormulaRollConfig", { subject: { actor } }, config);
    assert.deepEqual(config.parts, [formula]);
  }
});

test("sheet level updates create, replace upwards/downwards, then remove one effect", async () => {
  const actor = new MockActor();
  for (const level of [5, 8, 2, 0]) {
    await actor.update({ "system.attributes.exhaustion": level }); await settle();
    assert.equal(actor.system.attributes.exhaustion, level);
    assert.equal(actor._source.system.attributes.exhaustion, level);
    assert.equal(actor.effects.size, level ? 1 : 0);
    if (level) assert.equal(condition(actor).flags.dnd5e.exhaustionLevel, level);
  }
});

test("rapid sheet changes are serialized without duplicate conditions", async () => {
  const actor = new MockActor();
  await Promise.all([5, 8, 3].map(level => actor.update({ "system.attributes.exhaustion": level })));
  await settle(); assert.equal(actor.effects.size, 1); assert.equal(actor.system.attributes.exhaustion, 3);
  assert.equal(actor._source.system.attributes.exhaustion, 3);
});

test("dropping presets replaces a higher or lower condition and leaves no feature item", async () => {
  const actor = new MockActor(); await setExhaustion(actor, 8);
  for (const level of [3, 7, 0]) {
    await actor.createEmbeddedDocuments("Item", [exhaustionPresetData(level)]); await settle();
    assert.equal(actor.items.size, 0); assert.equal(actor.effects.size, level ? 1 : 0);
    assert.equal(actor.system.attributes.exhaustion, level);
  }
});

test("dropping the embedded ActiveEffect replaces the current condition", async () => {
  const actor = new MockActor(); await setExhaustion(actor, 8);
  await actor.createEmbeddedDocuments("ActiveEffect", [exhaustionEffectData(2)]); await settle();
  assert.equal(actor.effects.size, 1); assert.equal(actor.system.attributes.exhaustion, 2);
});

test("editing native exhaustion flags updates both visible and stored levels", async () => {
  const actor = new MockActor(); await setExhaustion(actor, 8);
  await actor.updateEmbeddedDocuments("ActiveEffect", [{
    _id: MockEffect.ID.EXHAUSTION, "flags.dnd5e.exhaustionLevel": 3
  }]); await settle();
  assert.equal(actor.system.attributes.exhaustion, 3); assert.equal(actor._source.system.attributes.exhaustion, 3);
  assert.equal(condition(actor).flags[MODULE_ID].exhaustionLevel, 3);
});

test("removing or disabling the effect resets the actor and does not recreate it", async () => {
  const actor = new MockActor(); await setExhaustion(actor, 5);
  await actor.deleteEmbeddedDocuments("ActiveEffect", [MockEffect.ID.EXHAUSTION]); await settle();
  assert.equal(actor.system.attributes.exhaustion, 0); assert.equal(actor._source.system.attributes.exhaustion, 0);
  await setExhaustion(actor, 5);
  await actor.updateEmbeddedDocuments("ActiveEffect", [{ _id: MockEffect.ID.EXHAUSTION, disabled: true }]);
  await settle(); assert.equal(actor.effects.size, 0); assert.equal(actor._source.system.attributes.exhaustion, 0);
});

test("native token-HUD condition and migrated duplicate effects become one managed effect", async () => {
  const actor = new MockActor();
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    _id: MockEffect.ID.EXHAUSTION, name: "Exhaustion", flags: {}, statuses: ["exhaustion"]
  }], { keepId: true }); await settle();
  assert.equal(actor.system.attributes.exhaustion, 1);
  actor.effects.set("old", new MockEffect({ ...exhaustionEffectData(6), _id: "old" }, actor));
  await setExhaustion(actor, 3); assert.equal(actor.effects.size, 1);
});

test("lowering the configured maximum clamps existing linked and unlinked actors", async () => {
  const actor = new MockActor(), tokenActor = new MockActor(); tokenActor.uuid = "Scene.scene.Token.token.Actor.actor";
  await setExhaustion(actor, 8); await setExhaustion(tokenActor, 7);
  game.actors = [actor]; game.scenes = [{ tokens: [{ actorLink: false, actor: tokenActor }] }];
  changeSetting("exhaustionMaxLevel", 4); await reconcileExhaustionActors();
  assert.equal(actor.system.attributes.exhaustion, 4); assert.equal(tokenActor.system.attributes.exhaustion, 4);
  await actor.update({ "system.attributes.exhaustion": 99 }); await settle();
  assert.equal(actor._source.system.attributes.exhaustion, 4);
});

test("legacy and modern penalties are removed, preserving other conditions and no death at cap", () => {
  CONFIG.DND5E.conditionEffects = {
    abilityCheckDisadvantage: new Set(["poisoned", "exhaustion-1"]),
    halfHealth: new Set(["exhaustion-4"]), noMovement: new Set(["grappled", "exhaustion-5"])
  };
  CONFIG.DND5E.conditionTypes.exhaustion = { levels: 6, reduction: { rolls: 2, speed: 5 } };
  configureExhaustionRules();
  assert.equal(CONFIG.DND5E.conditionTypes.exhaustion.levels, 10);
  assert.deepEqual(CONFIG.DND5E.conditionTypes.exhaustion.reduction, { rolls: 0, speed: 0 });
  assert.deepEqual([...CONFIG.DND5E.conditionEffects.abilityCheckDisadvantage], ["poisoned"]);
  assert.equal(CONFIG.DND5E.conditionEffects.halfHealth.size, 0);
  assert.deepEqual([...CONFIG.DND5E.conditionEffects.noMovement], ["grappled"]);
  const effect = new MockEffect(exhaustionEffectData(10, { id: MockEffect.ID.EXHAUSTION }));
  effect._prepareExhaustionLevel(); assert.equal(effect.statuses.has("dead"), false);
});

test("classic Tidy configuration and modern system configuration share maximum and hints", async () => {
  const calls = []; game.modules.set("tidy5e-sheet", { active: true });
  Hooks.call("tidy5e-sheet.ready", { config: { exhaustion: {
    async useSpecificLevelExhaustion(params) {
      calls.push(params); await game.settings.set("tidy5e-sheet", "exhaustionConfig", {
        type: "specific", hints: params.hints, levels: params.totalLevels
      });
    }
  } } });
  await configureTidyExhaustion(); await configureTidyExhaustion();
  assert.equal(calls.length, 1); assert.equal(calls[0].totalLevels, 10);
  assert.match(calls[0].hints[5], /−5/); assert.equal(calls[0].hints.length, 11);
});

test("presets have valid Foundry IDs and compendium folder, with a removable level zero", () => {
  assert.match(EXHAUSTION_FOLDER_ID, /^[A-Za-z0-9]{16}$/);
  for (let level = 0; level <= 100; level++) {
    const item = exhaustionPresetData(level, { maxLevel: 100, perLevel: 1, penalties: [] });
    assert.match(item._id, /^[A-Za-z0-9]{16}$/); assert.equal(item.folder, EXHAUSTION_FOLDER_ID);
    assert.equal(item.effects.length, level ? 1 : 0);
    if (level) assert.match(item.effects[0]._id, /^[A-Za-z0-9]{16}$/);
  }
});

test("compendium creation is idempotent, updates penalties, removes only obsolete presets and relocks", async () => {
  const docs = new Collection(), folders = new Collection(); let writes = 0;
  const pack = {
    collection: `${MODULE_ID}.features`, locked: true, folders,
    async configure({ locked }) { this.locked = locked; }, async getDocuments() { return [...docs]; }
  };
  game.packs.set(pack.collection, pack);
  globalThis.Folder = { async create(data) { assert.equal(pack.locked, false); folders.set(data._id, data); } };
  const wrap = data => ({ id: data._id, flags: data.flags, toObject: () => clone(data) });
  globalThis.Item = {
    async createDocuments(data) { assert.equal(pack.locked, false); for (const item of data) docs.set(item._id, wrap(item)); writes++; },
    async updateDocuments(data) { assert.equal(pack.locked, false); for (const item of data) docs.set(item._id, wrap(item)); writes++; },
    async deleteDocuments(ids) { assert.equal(pack.locked, false); for (const id of ids) docs.delete(id); writes++; }
  };
  docs.set("custom", wrap({ _id: "custom", flags: {}, name: "Custom feature" }));
  await ensureExhaustionPack(); assert.equal(docs.size, 12); assert.equal(pack.locked, true);
  const before = writes; await ensureExhaustionPack(); assert.equal(writes, before);
  changeSetting("exhaustionMaxLevel", 3); changeSetting("exhaustionPenaltyPerLevel", 2);
  await ensureExhaustionPack(); assert.equal(docs.size, 5); assert.ok(docs.has("custom"));
  assert.match(docs.get("apfceExhaust0003").toObject().name, /−6/); assert.equal(pack.locked, true);
});

test("remote hooks and non-owners cannot start a second synchronization", async () => {
  const actor = new MockActor(); actor.isOwner = false;
  await setExhaustion(actor, 5); assert.equal(actor.effects.size, 0);
  actor.isOwner = true;
  Hooks.call("createActiveEffect", new MockEffect(exhaustionEffectData(5), actor), {}, "other-user");
  await settle(); assert.equal(actor.effects.size, 0);
  assert.equal(actor.operations.length, 0);
  assert.equal(typeof SYNC_OPTION, "string");
});

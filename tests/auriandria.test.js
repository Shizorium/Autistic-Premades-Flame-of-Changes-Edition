import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MODULE_ID } from "../scripts/lib/identifier.js";
import { featureData, DESCRIPTIONS, FEATURE_IDS, FORM_IDS, AURIANDRIA_FOLDER_ID, AURIANDRIA_ACTOR_PACK, sacredFlameDice } from "../scripts/auriandria/data.js";
import { spellPointsItem, bindSpellPoints, consumeAuriandriaSpellPoints } from "../scripts/auriandria/spellpoints.js";
import { sharedResourceUpdates, performTransformation, choosePartner } from "../scripts/auriandria/forms.js";
import { useTransformation } from "../scripts/auriandria/index.js";
import { ensureAuriandriaLibrary } from "../scripts/auriandria/library.js";
import { moveAuriandriaFormsToCompendium } from "../scripts/auriandria/archive.js";
import { registerAuriandriaState, restoreAuriandriaEffectTemplates, rewriteReferences, transferBattleState } from "../scripts/auriandria/state.js";
import { battlefieldTargets, tokenDistanceFeet, expiryForSource, hasReachedExpiry, applyTransformationBurst, expireAuriandriaConditions } from "../scripts/auriandria/battlefield.js";

const clone = object => JSON.parse(JSON.stringify(object));
const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function put(object, path, value) {
  const keys = path.split("."), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  if (last.startsWith("-=")) delete object[last.slice(2)];
  else object[last] = clone(value);
}
function merge(object, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (key.includes(".")) put(object, key, value);
    else if (value && !Array.isArray(value) && typeof value === "object") merge(object[key] ??= {}, value);
    else object[key] = clone(value);
  }
}
class Collection extends Map {
  [Symbol.iterator]() { return this.values(); }
  find(fn) { return [...this].find(fn); }
  filter(fn) { return [...this].filter(fn); }
  some(fn) { return [...this].some(fn); }
}
let unique = 0, docs, settings, warnings, messages, hookHandlers, nativeRegistry, midiRegistry, riderCalls;
class RegistryMock {
  entries = new Map();
  get(parent) { return [...(this.entries.get(typeof parent === "string" ? parent : parent.uuid) ?? [])].map(uuid => docs.get(uuid)).filter(Boolean); }
  track(parent, document) {
    if (!parent) return;
    const entries = this.entries.get(parent) ?? new Set(); entries.add(document.uuid); this.entries.set(parent, entries);
  }
  untrack(parent, document) { this.entries.get(parent)?.delete(document.uuid); }
}
function emitHook(name, ...args) { for (const handler of hookHandlers.get(name) ?? []) if (handler(...args) === false) return false; }
// Foundry mutates operation objects and retains parentUuid after serializing a request.
function databaseOperation(document, type, options) {
  options.parent = type === document.documentName ? document.parent : document;
  options.pack = document.pack;
  const parent = options.parent ?? docs.get(options.parentUuid);
  if (type === "Actor" && parent?.documentName === "Actor") {
    throw new Error("Actor is not a valid embedded Document within the Actor Document");
  }
  if (parent) options.parentUuid = parent.uuid;
  delete options.parent;
}
class ItemMock {
  constructor(data, actor) {
    this._source = clone(data); this.parent = actor; this.documentName = "Item";
    Object.assign(this, clone(data)); this.id = data._id ?? `item${unique++}`;
    this.actor = actor; this.uuid = `${actor.uuid}.Item.${this.id}`;
    this.system.activities = new Collection(Object.values(data.system.activities ?? {}).map(a => [a._id, { ...a, id: a._id, uuid: `${this.uuid}.Activity.${a._id}` }]));
    this.effects = new Collection((data.effects ?? []).map(effect => { const doc = new EffectMock(effect, this); return [doc.id, doc]; }));
    docs.set(this.uuid, this);
    if (data.flags?.dnd5e?.dependentOn) { nativeRegistry.track(data.flags.dnd5e.dependentOn, this); midiRegistry.track(data.flags.dnd5e.dependentOn, this); }
  }
  toObject() { return { ...clone(this._source), _id: this.id, effects: [...this.effects].map(effect => effect.toObject()) }; }
  async update(changes, options = {}) {
    databaseOperation(this, "Item", options);
    merge(this._source, changes); merge(this, changes);
    if (!options.noHook) emitHook("updateItem", this, changes, options);
  }
  async createEmbeddedDocuments(type, entries, options) { return ActorMock.prototype.createEmbeddedDocuments.call(this, type, entries, options); }
  async deleteEmbeddedDocuments(type, ids, options) { return ActorMock.prototype.deleteEmbeddedDocuments.call(this, type, ids, options); }
  async delete(options) { return this.parent.deleteEmbeddedDocuments("Item", [this.id], options); }
}
class EffectMock {
  static ID = { EXHAUSTION: "exhaustion" };
  constructor(data, actor) {
    this._source = clone(data); this.id = data._id ?? `effect${unique++}`; this.parent = actor;
    Object.assign(this, clone(data)); this.statuses = new Set(data.statuses ?? []);
    this.uuid = `${actor.uuid}.ActiveEffect.${this.id}`; this.documentName = "ActiveEffect";
    docs.set(this.uuid, this);
    if (data.flags?.dnd5e?.dependentOn) { nativeRegistry.track(data.flags.dnd5e.dependentOn, this); midiRegistry.track(data.flags.dnd5e.dependentOn, this); }
  }
  toObject() { return { ...clone(this._source), _id: this.id }; }
  getFlag(scope, key) { return get(this.flags?.[scope], key); }
  getDependents() {
    return [...new Set([...(this.flags?.dnd5e?.dependents ?? []).map(entry => docs.get(entry.uuid)).filter(Boolean), ...nativeRegistry.get(this)])];
  }
  async createRiderConditions() { if (this.flags?.dnd5e?.riders?.statuses?.length) riderCalls++; }
  async update(changes, options = {}) {
    databaseOperation(this, "ActiveEffect", options);
    merge(this._source, changes); Object.assign(this, clone(this._source)); this.statuses = new Set(this._source.statuses ?? []);
    if (!options.noHook) emitHook("updateActiveEffect", this, changes, options);
  }
  async delete(options) { return this.parent.deleteEmbeddedDocuments("ActiveEffect", [this.id], options); }
}
class ActorMock {
  constructor(id, form, { hp = 18, maxHP = 31, maxSP = 17, spent = 4, level = 4 } = {}) {
    this.id = id; this.uuid = `Actor.${id}`; this.documentName = "Actor"; this.type = "character";
    this.name = id; this.flags = { [MODULE_ID]: { auriandriaForm: form, auriandriaGroup: "auriandria" }, dnd5espellpoints: { item: "points" } };
    this.system = {
      attributes: { hp: { value: hp, max: maxHP, effectiveMax: maxHP, temp: 3, tempmax: -5 },
        spellcasting: "wis", spell: { dc: 14 }, prof: 2, exhaustion: 0, inspiration: false },
      details: { level }, abilities: { wis: { dc: 14, mod: 4 } }, traits: { ci: { value: new Set() } }, spells: {}
    };
    this._source = { system: clone(this.system) }; this.effects = new Collection(); this.items = new Collection();
    this.ownership = { player: 3 }; this.isOwner = true;
    this.prototypeToken = { name: id, texture: { src: `${form}.webp` }, sight: { enabled: true }, detectionModes: [], width: 1, height: 1,
      toObject() { const { toObject, ...data } = this; return clone(data); } };
    this.addItem({ _id: "points", name: "Spell Points", type: "feat", system: { identifier: "spell-points", source: { custom: "Spell Points" }, uses: { max: maxSP, spent } } });
    this.addItem({ _id: "cleric", name: "Жрец", type: "class", system: { identifier: "cleric", levels: level } });
    this.addItem({ ...featureData(form === "sun" ? "moon" : "sun"), folder: null });
    docs.set(this.uuid, this);
  }
  addItem(data) { const item = new ItemMock(data, this); this.items.set(item.id, item); return item; }
  toCompendium() { return { name: this.name, type: this.type, flags: clone(this.flags), system: clone(this.system),
    items: [...this.items].map(item => item.toObject()), effects: [...this.effects].map(effect => effect.toObject()) }; }
  testUserPermission() { return true; }
  async update(changes, options = {}) {
    databaseOperation(this, "Actor", options);
    merge(this._source, changes); merge(this, changes);
    const hp = this.system.attributes.hp;
    hp.effectiveMax = hp.max + (Number(hp.tempmax) || 0);
    if (!options.noHook) emitHook("updateActor", this, changes, options);
  }
  async createEmbeddedDocuments(type, entries, options = {}) {
    databaseOperation(this, type, options);
    const created = [];
    for (const data of entries) {
      if (type === "Item") { created.push(this.addItem(data)); continue; }
      const effect = new EffectMock(data, this); this.effects.set(effect.id, effect);
      if (effect.id === "exhaustion" && this.documentName === "Actor") this.system.attributes.exhaustion = effect.flags.dnd5e.exhaustionLevel;
      await effect.createRiderConditions(); created.push(effect);
    }
    return created;
  }
  async updateEmbeddedDocuments(type, entries, options = {}) {
    databaseOperation(this, type, options);
    for (const data of entries) {
      const document = (type === "Item" ? this.items : this.effects).get(data._id);
      await document.update(data);
      if (document.id === "exhaustion") this.system.attributes.exhaustion = document.flags.dnd5e.exhaustionLevel;
    }
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    databaseOperation(this, type, options);
    for (const id of ids) {
      const collection = type === "Item" ? this.items : this.effects, document = collection.get(id);
      if (!document) continue;
      const dependents = type === "Item" ? [...document.effects].flatMap(effect => effect.getDependents()) : document.getDependents();
      collection.delete(id); docs.delete(document.uuid);
      for (const dependent of dependents) await dependent.delete();
      nativeRegistry.untrack(document.flags?.dnd5e?.dependentOn, document); midiRegistry.untrack(document.flags?.dnd5e?.dependentOn, document);
      if (type === "Item") await this.endConcentration?.(document);
    }
  }
  get concentration() { return { effects: new Set([...this.effects].filter(effect => effect.statuses.has("concentrating"))) }; }
  async endConcentration(target) {
    for (const effect of this.concentration.effects) {
      if (target && target !== effect && target.id !== effect.flags?.dnd5e?.item?.id) continue;
      await effect.delete();
    }
  }
  async delete() { game.actors.delete(this.id); docs.delete(this.uuid); }
  async applyDamage(damage) {
    this.applied ??= []; this.applied.push(clone(damage));
    const amount = damage.reduce((sum, part) => sum + (part.type === "healing" ? -part.value : part.value), 0);
    this.system.attributes.hp.value = Math.min(this.system.attributes.hp.effectiveMax, Math.max(0, this.system.attributes.hp.value - amount));
  }
  async rollSavingThrow(config) { this.saveConfig = config; return [{ total: this.saveTotal ?? 4 }]; }
}
function sceneMock() {
  return { id: "scene", tokens: new Collection(), grid: {
    size: 100, units: "ft", measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 20 })
  } };
}
function tokenMock(scene, id, actor, x, disposition) {
  const token = { id, documentName: "Token", uuid: `Scene.scene.Token.${id}`, parent: scene,
    actorId: actor.id, actorLink: true, x, y: 0, width: 1, height: 1, elevation: 0, disposition, texture: { src: "old.webp" }, name: id,
    get actor() { return game.actors.get(this.actorId); },
    async update(changes) { merge(this, changes); }
  };
  scene.tokens.set(id, token); docs.set(token.uuid, token); return token;
}
beforeEach(() => {
  docs = new Map(); warnings = []; messages = [];
  hookHandlers = new Map(); nativeRegistry = new RegistryMock(); midiRegistry = new RegistryMock(); riderCalls = 0;
  globalThis.Hooks = { on(name, handler) { const handlers = hookHandlers.get(name) ?? []; handlers.push(handler); hookHandlers.set(name, handlers); } };
  settings = { exhaustionMaxLevel: 10, exhaustionPenaltyPerLevel: 1, exhaustionPenaltyTable: "" };
  globalThis.CONFIG = { Actor: { documentClass: ActorMock }, ActiveEffect: { documentClass: EffectMock }, specialStatusEffects: { CONCENTRATING: "concentrating" }, Dice: {
    DamageRoll: class {
      constructor(formula) { this.formula = formula; this.total = Number.parseInt(formula) * 4; }
      async evaluate() { return this; } async toMessage() { messages.push(this.formula); }
    }
  } };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
  globalThis.foundry = { utils: { deepClone: clone, getProperty: get, setProperty: put, escapeHTML: value => value, randomID: () => `random${String(unique++).padStart(10, "0")}` } };
  globalThis.game = {
    user: { id: "gm" }, users: new Collection([["gm", { id: "gm", active: true }], ["player", { id: "player", active: true }]]),
    actors: new Collection(), scenes: [], combats: [], messages: [], dnd5e: { registry: { dependents: nativeRegistry } }, modules: new Map([["dnd5e-spellpoints", { active: true }]]), time: { worldTime: 100 },
    settings: { get: (scope, key) => scope === MODULE_ID ? settings[key] : { spResource: "Spell Points", spellPointsCosts: { 0: 0, 1: 2, 2: 3, 3: 5 } } }
  };
  game.users.activeGM = game.users.get("gm");
  globalThis.ui = { notifications: { warn: value => warnings.push(value), error: value => warnings.push(value) } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => { messages.push(data); } };
  globalThis.ActiveEffect = { implementation: { fromStatusEffect: async status => ({ toObject: () => ({ statuses: [status], flags: {} }) }) } };
  globalThis.fromUuid = async uuid => docs.get(uuid);
  globalThis.fromUuidSync = uuid => docs.get(uuid);
  globalThis.MidiQOL = { MidiDependentsRegistry: midiRegistry };
  registerAuriandriaState();
});
function addActor(actor) { game.actors.set(actor.id, actor); return actor; }

test("all features and forms have valid IDs and include only requested descriptive text", () => {
  for (const id of [AURIANDRIA_FOLDER_ID, ...Object.values(FEATURE_IDS), ...Object.values(FORM_IDS)]) assert.match(id, /^[A-Za-z0-9]{16}$/);
  assert.equal(Object.keys(featureData("rules").system.activities).length, 0);
  for (const text of Object.values(DESCRIPTIONS)) assert.doesNotMatch(text, /автоматиз|Здесь соответственно|Эта особенность/);
  assert.match(DESCRIPTIONS.moon, /4 × уровень/); assert.match(DESCRIPTIONS.moon, /11-го/);
});

test("imported forms keep original spells, classes and working spellpoint item references", () => {
  for (const form of ["sun", "moon"]) {
    const actor = JSON.parse(fs.readFileSync(new URL(`../pack-src/auriandria/${form}.json`, import.meta.url), "utf8"));
    const points = actor.items.find(item => item._id === actor.flags.dnd5espellpoints.item);
    assert.equal(points.system.identifier, "spell-points");
    assert.equal(actor.items.filter(item => item.type === "spell").length, form === "sun" ? 41 : 42);
    assert.equal(actor.items.filter(item => item.flags?.[MODULE_ID]?.auriandriaRules).length, 1);
    const transitions = actor.items.filter(item => item.flags?.[MODULE_ID]?.auriandriaTransition);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].flags[MODULE_ID].auriandriaTransition, form === "sun" ? "moon" : "sun");
    assert.equal(actor.prototypeToken.actorLink, true);
  }
});

test("resource transfer preserves remaining points rather than spent points across different pools", () => {
  const sun = new ActorMock("sun", "sun", { maxSP: 17, spent: 7 }), moon = new ActorMock("moon", "moon", { maxSP: 25 });
  const updates = sharedResourceUpdates(sun, moon);
  assert.equal(updates.actor["system.attributes.hp.value"], 18);
  assert.equal(updates.actor["system.attributes.hp.tempmax"], -5);
  assert.equal(updates.item.find(item => item._id === "points")["system.uses.spent"], 15);
});

test("spellpoint lookup repairs a stale embedded item ID and renamed resource", async () => {
  const actor = new ActorMock("sun", "sun"); actor.flags.dnd5espellpoints.item = "deleted";
  const points = spellPointsItem(actor); await bindSpellPoints(actor);
  assert.equal(points.id, "points"); assert.equal(actor.flags.dnd5espellpoints.item, "points");
});

function consumption(actor, level, consume = { spellPoints: true, spellSlot: false }) {
  const activity = { actor, isSpell: true, consumption: { spellSlot: true }, item: { system: { level } } };
  const updates = { actor: {}, item: [] };
  const result = consumeAuriandriaSpellPoints(activity, { consume }, { data: { flags: { dnd5e: { use: { spellLevel: level } } } } }, updates);
  return { result, updates };
}
test("normal and upcast spells use the configured cost once, cantrips and free casts cost nothing", () => {
  const actor = new ActorMock("sun", "sun", { spent: 4 });
  assert.equal(consumption(actor, 1).updates.item[0]["system.uses.spent"], 6);
  assert.equal(consumption(actor, 3).updates.item[0]["system.uses.spent"], 9);
  assert.equal(consumption(actor, 0).updates.item.length, 0);
  assert.equal(consumption(actor, 1, { spellPoints: false, spellSlot: false }).updates.item.length, 0);
  assert.equal(consumption(actor, 1, { spellPoints: true, spellSlot: true }).updates.item.length, 0);
});

test("a spell with insufficient points is cancelled before any resource update", () => {
  const actor = new ActorMock("sun", "sun", { spent: 16 });
  const outcome = consumption(actor, 1);
  assert.equal(outcome.result, false); assert.equal(outcome.updates.item.length, 0);
  assert.equal(spellPointsItem(actor).system.uses.spent, 16); assert.equal(warnings.length, 1);
});

test("Sacred Flame scales at total character levels 5, 11 and 17", () => {
  assert.deepEqual([1, 4, 5, 10, 11, 16, 17, 20].map(sacredFlameDice), [1, 1, 2, 2, 3, 3, 4, 4]);
});

test("battlefield selection includes distant allies and only nearby opposing creatures", () => {
  const scene = sceneMock();
  const source = tokenMock(scene, "source", addActor(new ActorMock("sun", "sun")), 0, 1);
  tokenMock(scene, "near", addActor(new ActorMock("near", "moon")), 300, -1);
  tokenMock(scene, "far", addActor(new ActorMock("far", "moon")), 400, -1);
  tokenMock(scene, "neutral", addActor(new ActorMock("neutral", "moon")), 100, 0);
  tokenMock(scene, "ally", addActor(new ActorMock("ally", "sun")), 2000, 1);
  assert.equal(battlefieldTargets(source).enemies.length, 1);
  assert.equal(battlefieldTargets(source).allies.length, 1);
  const large = scene.tokens.get("near"); large.x = 400; large.width = 2;
  assert.equal(tokenDistanceFeet(source, large), 20);
});

test("moon burst rolls Wisdom saves, applies fear only on failure and restores no resources", async () => {
  const scene = sceneMock(), moon = addActor(new ActorMock("moon", "moon"));
  const source = tokenMock(scene, "source", moon, 0, 1);
  const enemy = addActor(new ActorMock("enemy", "sun")); tokenMock(scene, "enemy", enemy, 100, -1);
  const saved = addActor(new ActorMock("saved", "sun")); saved.saveTotal = 16; tokenMock(scene, "saved", saved, 200, -1);
  const ally = addActor(new ActorMock("ally", "sun", { spent: 12 })); tokenMock(scene, "ally", ally, 500, 1);
  const result = await applyTransformationBurst(moon, "moon", source);
  assert.equal(result.failed, 1); assert.equal(enemy.saveConfig.ability, "wis"); assert.equal(saved.effects.size, 0);
  assert.ok([...enemy.effects][0].statuses.has("frightened")); assert.equal(enemy.applied, undefined);
  assert.equal(spellPointsItem(ally).system.uses.spent, 12); assert.equal(ally.applied, undefined);
});

test("sun burst heals all allies, damages and blinds only failed Dexterity saves", async () => {
  const scene = sceneMock(), sun = addActor(new ActorMock("sun", "sun", { level: 11 }));
  const source = tokenMock(scene, "source", sun, 0, 1);
  const enemy = addActor(new ActorMock("enemy", "moon")); tokenMock(scene, "enemy", enemy, 100, -1);
  const saved = addActor(new ActorMock("saved", "moon")); saved.saveTotal = 14; tokenMock(scene, "saved", saved, 200, -1);
  const ally = addActor(new ActorMock("ally", "sun")); tokenMock(scene, "ally", ally, 500, 1);
  await applyTransformationBurst(sun, "sun", source);
  assert.deepEqual(ally.applied[0], [{ value: 55, type: "healing" }]);
  assert.deepEqual(enemy.applied[0], [{ value: 12, type: "radiant" }]);
  assert.ok([...enemy.effects][0].statuses.has("blinded")); assert.equal(saved.applied, undefined);
  assert.equal(enemy.saveConfig.rolls[0].data.cover, 0); assert.equal(sun.applied, undefined);
});

test("fear and blindness expire after the source's next turn, not its current turn or the target's turn", () => {
  const scene = sceneMock(), actor = addActor(new ActorMock("sun", "sun"));
  const source = tokenMock(scene, "source", actor, 0, 1);
  const combat = { id: "combat", started: true, round: 3, turn: 0, scene,
    turns: [{ id: "caster", tokenId: "source" }, { id: "enemy", tokenId: "enemy" }] };
  const expiry = expiryForSource(source, combat); assert.equal(expiry.round, 4);
  combat.previous = { round: 3, turn: 0 }; combat.turn = 1; assert.equal(hasReachedExpiry(expiry, combat), false);
  combat.previous = { round: 4, turn: 0 }; combat.round = 4; assert.equal(hasReachedExpiry(expiry, combat), true);
  combat.round = 3; combat.turn = 0; combat.turns.reverse();
  assert.equal(expiryForSource(source, combat).round, 3);
});

test("expiration deletes only this module's conditions and leaves unrelated effects", async () => {
  const actor = addActor(new ActorMock("enemy", "moon"));
  await actor.createEmbeddedDocuments("ActiveEffect", [
    { _id: "ours", statuses: ["frightened"], flags: { [MODULE_ID]: { auriandriaCondition: true, expiry: { worldTime: 105 } } } },
    { _id: "unrelated", statuses: ["frightened"], flags: {} }
  ]);
  await expireAuriandriaConditions(null, { worldTime: 106 });
  assert.equal(actor.effects.has("ours"), false); assert.equal(actor.effects.has("unrelated"), true);
});

test("live world forms switch both ways while retaining edits, spellpoint expenditure and token identity", async () => {
  const sun = addActor(new ActorMock("sun", "sun", { hp: 18, spent: 7 }));
  const moon = addActor(new ActorMock("moon", "moon"));
  moon.addItem({ _id: "custom", name: "Редактируемая особенность", type: "feat", system: {} });
  const scene = sceneMock(); game.scenes = [scene];
  const token = tokenMock(scene, "source", sun, 0, 1);
  assert.equal(await choosePartner(sun, "moon"), moon);
  const request = (source, target, form) => ({ userId: "player", actorUuid: source.uuid,
    itemUuid: [...source.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition === form).uuid,
    targetUuid: target.uuid, tokenUuid: token.uuid });
  await performTransformation(request(sun, moon, "moon"));
  assert.equal(token.actorId, moon.id); assert.equal(token.id, "source"); assert.equal(moon.items.has("custom"), true);
  assert.equal(moon.system.attributes.hp.value, 18); assert.equal(spellPointsItem(moon).system.uses.spent, 7);
  await spellPointsItem(moon).update({ "system.uses.spent": 10 }); moon.system.attributes.hp.value = 12;
  await performTransformation(request(moon, sun, "sun"));
  assert.equal(token.actorId, sun.id); assert.equal(sun.system.attributes.hp.value, 12);
  assert.equal(spellPointsItem(sun).system.uses.spent, 10); assert.equal(sun.system.attributes.exhaustion, 0);
  assert.equal(sun._source.system.attributes.hp.tempmax, -5);
});

test("using each form feature opens the destination sheet and changes the token appearance", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const scene = sceneMock(); game.scenes = [scene];
  const token = tokenMock(scene, "source", sun, 0, 1);
  const previousCanvas = globalThis.canvas;
  globalThis.canvas = { tokens: { controlled: [{ get actor() { return token.actor; }, document: token }] } };
  game.user.isGM = true;
  for (const actor of [sun, moon]) actor.sheet = {
    rendered: actor === sun,
    async close(options) { assert.equal(options.submit, false); this.rendered = false; },
    render(force) { assert.equal(force, true); this.rendered = true; }
  };
  try {
    for (const [source, target] of [[sun, moon], [moon, sun]]) {
      await useTransformation([...source.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition));
      assert.deepEqual(warnings, []);
      assert.equal(token.actor, target); assert.equal(token.texture.src, `${target.flags[MODULE_ID].auriandriaForm}.webp`);
      assert.equal(source.sheet.rendered, false); assert.equal(target.sheet.rendered, true);
    }
  } finally { globalThis.canvas = previousCanvas; }
});

test("invalid prototype data fails before resources, effects or active-form flags change", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon", { hp: 7, spent: 10 }));
  const spell = addSpell(sun); await concentrate(sun, spell);
  const scene = sceneMock(); game.scenes = [scene]; const token = tokenMock(scene, "source", sun, 0, 1);
  moon.prototypeToken.toObject = () => { throw new Error("Invalid prototype data"); };
  await assert.rejects(performTransformation({ userId: "player", actorUuid: sun.uuid,
    itemUuid: sun.items.find(item => item.flags?.[MODULE_ID]?.auriandriaTransition).uuid,
    targetUuid: moon.uuid, tokenUuid: token.uuid }), /Invalid prototype/);
  assert.equal(token.actor, sun); assert.equal(sun.concentration.effects.size, 1);
  assert.equal(moon.system.attributes.hp.value, 7); assert.equal(spellPointsItem(moon).system.uses.spent, 10);
  assert.equal(sun.flags[MODULE_ID].auriandriaActiveActor, undefined);
});

test("a failed token update rolls back resources and concentration, allowing the same feature to retry", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon", { hp: 7, spent: 10 }));
  const spell = addSpell(sun); addSpell(moon); const focus = await concentrate(sun, spell);
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "buff", statuses: [],
    flags: { dnd5e: { dependentOn: focus.uuid } } }]))[0];
  const scene = sceneMock(); game.scenes = [scene]; const token = tokenMock(scene, "source", sun, 0, 1);
  const update = token.update.bind(token); let reject = true;
  token.update = async (changes, options) => {
    if (reject && changes.actorId === moon.id) { reject = false; throw new Error("Token update rejected"); }
    return update(changes, options);
  };
  const request = { userId: "player", actorUuid: sun.uuid,
    itemUuid: sun.items.find(item => item.flags?.[MODULE_ID]?.auriandriaTransition).uuid,
    targetUuid: moon.uuid, tokenUuid: token.uuid };
  await assert.rejects(performTransformation(request), /Token update rejected/);
  assert.equal(token.actor, sun); assert.equal(moon.system.attributes.hp.value, 7);
  assert.equal(spellPointsItem(moon).system.uses.spent, 10);
  assert.equal(sun.flags[MODULE_ID].auriandriaActiveActor, undefined);
  assert.equal(moon.flags[MODULE_ID].auriandriaActiveActor, undefined);
  assert.equal(sun.concentration.effects.size, 1); assert.equal(moon.concentration.effects.size, 0);
  assert.equal(buff.flags.dnd5e.dependentOn, focus.uuid);
  await performTransformation(request);
  assert.equal(token.actor, moon); assert.equal(moon.concentration.effects.size, 1);
});

test("a late failure restores the token and clears form flags after the token already switched", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const scene = sceneMock(); game.scenes = [scene]; const token = tokenMock(scene, "source", sun, 0, 1);
  const update = sun.update.bind(sun); let reject = true;
  sun.update = async (changes, options) => {
    if (reject && changes[`flags.${MODULE_ID}.auriandriaActiveActor`] === moon.uuid) {
      assert.equal(token.actor, moon); reject = false; throw new Error("Flag update rejected");
    }
    return update(changes, options);
  };
  await assert.rejects(performTransformation({ userId: "player", actorUuid: sun.uuid,
    itemUuid: sun.items.find(item => item.flags?.[MODULE_ID]?.auriandriaTransition).uuid,
    targetUuid: moon.uuid, tokenUuid: token.uuid }), /Flag update rejected/);
  assert.equal(token.actor, sun); assert.equal(token.texture.src, "old.webp");
  assert.equal(sun.flags[MODULE_ID].auriandriaActiveActor, undefined);
  assert.equal(moon.flags[MODULE_ID].auriandriaActiveActor, undefined);
});

test("a transition interrupted by the old texture error resumes without copying depleted source state", async () => {
  const sun = addActor(new ActorMock("sun", "sun", { spent: 1 })), moon = addActor(new ActorMock("moon", "moon", { hp: 7, spent: 10 }));
  const spell = addSpell(sun); addSpell(moon); await concentrate(sun, spell);
  const scene = sceneMock(); game.scenes = [scene]; const token = tokenMock(scene, "source", sun, 0, 1);
  await transferBattleState(sun, moon);
  await sun.update({ [`flags.${MODULE_ID}.auriandriaActiveActor`]: moon.uuid });
  await moon.update({ [`flags.${MODULE_ID}.auriandriaActiveActor`]: moon.uuid,
    [`flags.${MODULE_ID}.auriandriaPartner`]: sun.uuid });
  await performTransformation({ userId: "player", actorUuid: sun.uuid,
    itemUuid: sun.items.find(item => item.flags?.[MODULE_ID]?.auriandriaTransition).uuid,
    targetUuid: moon.uuid, tokenUuid: token.uuid });
  assert.equal(token.actor, moon); assert.equal(token.texture.src, "moon.webp");
  assert.equal(moon.concentration.effects.size, 1); assert.equal(moon.system.attributes.hp.value, 7);
  assert.equal(spellPointsItem(moon).system.uses.spent, 10);
});

test("a forged request using an unrelated feature cannot change form", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  await assert.rejects(performTransformation({ userId: "player", actorUuid: sun.uuid,
    itemUuid: spellPointsItem(sun).uuid, targetUuid: moon.uuid }), /Невозможно/);
  assert.equal(moon.system.attributes.hp.value, 18);
});

function libraryMock(actorPackAvailable = false) {
  const pack = collection => ({ collection, locked: true, folders: new Collection(), documents: new Collection(),
    async configure({ locked }) { this.locked = locked; },
    async getIndex() { return this.documents; }, async getDocument(id) { return this.documents.get(id); }, render() { this.rendered = true; }
  });
  const features = pack(`${MODULE_ID}.features`), forms = pack(`world.${AURIANDRIA_ACTOR_PACK}`);
  game.packs = new Map([[features.collection, features], [forms.collection, forms]]); game.folders = new Collection();
  if (!actorPackAvailable) game.packs.delete(forms.collection);
  foundry.documents = { collections: { CompendiumCollection: { async createCompendium(data) {
    assert.equal(data.type, "Actor"); assert.equal(data.name, AURIANDRIA_ACTOR_PACK);
    game.packs.set(forms.collection, forms); return forms;
  } } } };
  globalThis.Folder = { async create(data, options = {}) {
    const folder = { ...data, id: data._id ?? `folder${unique++}` };
    if (options.pack) game.packs.get(options.pack).folders.set(folder.id, folder);
    else throw new Error("World folders must be created only by the user");
    return folder;
  } };
  globalThis.Item = { async create(data, options) {
    const destination = game.packs.get(options.pack); assert.equal(destination.locked, false);
    destination.documents.set(data._id, { id: data._id, toObject: () => clone(data) });
  } };
  globalThis.Actor = { async create(data, options) {
    assert.ok(options.pack, "World actors must be imported manually"); assert.equal(options.keepEmbeddedIds, true);
    const destination = game.packs.get(options.pack); assert.equal(destination.locked, false);
    if (data.flags?.["scene-packer"]) data.flags["scene-packer"].hash = "recalculated-for-compendium";
    destination.documents.set(data._id, { ...clone(data), id: data._id, toObject: () => clone(data) });
  }, async deleteDocuments(ids) { for (const id of ids) game.actors.delete(id); } };
  foundry.utils.fetchJsonWithTimeout = async path => JSON.parse(fs.readFileSync(new URL(`../${path.split(`/modules/${MODULE_ID}/`).pop().replace(`modules/${MODULE_ID}/`, "")}`, import.meta.url), "utf8"));
  return { features, forms };
}

for (const actorPackAvailable of [true, false]) test(`library only creates compendium templates with pack ${actorPackAvailable ? "existing" : "new"}`, async () => {
  const { features, forms } = libraryMock(actorPackAvailable);
  await ensureAuriandriaLibrary(); assert.equal(game.actors.size, 0); assert.equal(forms.documents.size, 2);
  assert.ok(features.folders.get(AURIANDRIA_FOLDER_ID));
  for (const id of Object.values(FEATURE_IDS)) assert.ok(features.documents.get(id));
  const template = forms.documents.get(FORM_IDS.sun).toObject();
  const sun = addActor(new ActorMock("manualImport", "sun"));
  sun.name = "Новое имя"; sun.system.abilities.wis.mod = 7; await spellPointsItem(sun).update({ "system.uses.spent": 13 });
  await ensureAuriandriaLibrary();
  assert.equal(game.actors.size, 1); assert.equal(sun.name, "Новое имя"); assert.equal(sun.system.abilities.wis.mod, 7);
  assert.equal(spellPointsItem(sun).system.uses.spent, 13);
  assert.deepEqual(forms.documents.get(FORM_IDS.sun).toObject(), template);
  game.actors.delete(sun.id); await ensureAuriandriaLibrary(); assert.equal(game.actors.size, 0);
  assert.equal(features.locked, true); assert.equal(forms.locked, true);
});

test("explicit relocation preserves current sheets and clears links to removed world copies", async () => {
  const { forms } = libraryMock(); game.user.isGM = true;
  const sun = addActor(new ActorMock("sun", "sun", { spent: 9 })), moon = addActor(new ActorMock("moon", "moon"));
  sun.name = "Солнце с правками"; sun.flags[MODULE_ID].auriandriaPartner = moon.uuid;
  sun.flags[MODULE_ID].auriandriaActiveActor = sun.uuid;
  sun.flags["scene-packer"] = { hash: "original-world-checksum", sourceId: "preserved-reference" };
  const result = await moveAuriandriaFormsToCompendium([sun.id, moon.id]);
  assert.equal(game.actors.size, 0); assert.equal(result.pack, forms.collection);
  const copy = forms.documents.get(FORM_IDS.sun);
  assert.equal(copy.name, sun.name); assert.equal(copy.items.find(item => item._id === "points").system.uses.spent, 9);
  assert.equal(copy.flags[MODULE_ID].auriandriaPartner, undefined);
  assert.equal(copy.flags[MODULE_ID].auriandriaActiveActor, undefined);
  assert.equal(copy.flags["scene-packer"].sourceId, "preserved-reference");
  await ensureAuriandriaLibrary(); assert.equal(game.actors.size, 0);
});

test("a changed archived copy prevents removal of either source actor", async () => {
  libraryMock(); game.user.isGM = true;
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  await ensureAuriandriaLibrary(); moon.name = "Изменения после архивации";
  await assert.rejects(moveAuriandriaFormsToCompendium([sun.id, moon.id]), /отличается/);
  assert.equal(game.actors.size, 2);
});

test("a removed shared condition does not reappear when returning to the inactive form", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  await sun.createEmbeddedDocuments("ActiveEffect", [{ _id: "poison", statuses: ["poisoned"], flags: {} }]);
  const scene = sceneMock(); game.scenes = [scene]; const token = tokenMock(scene, "source", sun, 0, 1);
  const request = (source, target, form) => ({ userId: "player", actorUuid: source.uuid,
    itemUuid: [...source.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition === form).uuid,
    targetUuid: target.uuid, tokenUuid: token.uuid });
  await performTransformation(request(sun, moon, "moon")); assert.equal(moon.effects.size, 1);
  await moon.deleteEmbeddedDocuments("ActiveEffect", [...moon.effects].map(effect => effect.id));
  await performTransformation(request(moon, sun, "sun")); assert.equal(sun.effects.size, 0);
});

function addSpell(actor, id = "bless", activityId = "cast") {
  return actor.addItem({ _id: id, name: "Благословение", type: "spell", flags: {}, system: {
    identifier: "bless", level: 1, activities: { [activityId]: { _id: activityId, name: "Сотворить", type: "utility" } }
  } });
}
async function concentrate(actor, item, id = "focus") {
  const activity = [...item.system.activities][0];
  return (await actor.createEmbeddedDocuments("ActiveEffect", [{
    _id: id, name: "Концентрация: Благословение", origin: item.uuid, statuses: ["concentrating"],
    duration: { seconds: 60, startTime: 80, rounds: 10, startRound: 3, startTurn: 1, combat: "combat" },
    flags: { dnd5e: { item: { id: item.id, uuid: item.uuid, type: item.type },
      activity: { id: activity.id, uuid: activity.uuid, type: activity.type } } }
  }]))[0];
}

test("both form switches preserve concentration with ambient sound filter settings in another scene", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const sunSpell = addSpell(sun, "spellSun", "castSun"), moonSpell = addSpell(moon, "spellMoon", "castMoon");
  const focus = await concentrate(sun, sunSpell);
  const scene = sceneMock(), otherScene = { ...sceneMock(), id: "other", sounds: new Collection() };
  game.scenes = [scene, otherScene];
  const token = tokenMock(scene, "source", sun, 0, 1);
  const filters = { base: { type: "lowpass", intensity: 5 }, muffled: { type: "", intensity: 5 } };
  const sound = {
    id: "sound", uuid: "Scene.other.AmbientSound.sound", documentName: "AmbientSound",
    effects: clone(filters), flags: { dnd5e: { origin: sunSpell.uuid } },
    async update(changes, options = {}) {
      merge(this, changes);
      if (!options.noHook) emitHook("updateAmbientSound", this, changes, options);
    }
  };
  otherScene.sounds.set(sound.id, sound); docs.set(sound.uuid, sound);
  for (const [source, target, form, spell] of [[sun, moon, "moon", moonSpell], [moon, sun, "sun", sunSpell]]) {
    await performTransformation({ userId: "player", actorUuid: source.uuid,
      itemUuid: [...source.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition === form).uuid,
      targetUuid: target.uuid, tokenUuid: token.uuid });
    assert.equal(token.actorId, target.id);
    assert.equal(source.concentration.effects.size, 0); assert.equal(target.concentration.effects.size, 1);
    assert.equal(target.effects.get(focus.id).flags.dnd5e.item.uuid, spell.uuid);
    assert.equal(sound.flags.dnd5e.origin, spell.uuid);
    assert.deepEqual(sound.effects, filters);
  }
});

function templateMock(scene, parent, origin) {
  const template = {
    id: "template", uuid: `Scene.${scene.id}.MeasuredTemplate.template`, documentName: "MeasuredTemplate",
    flags: { dnd5e: { dependentOn: parent.uuid, origin } }, removed: false,
    async update(changes, options = {}) { merge(this, changes); if (!options.noHook) emitHook("updateMeasuredTemplate", this, changes, options); },
    async delete() { this.removed = true; docs.delete(this.uuid); scene.templates.delete(this.id); }
  };
  scene.templates ??= new Collection(); scene.templates.set(template.id, template); docs.set(template.uuid, template);
  nativeRegistry.track(parent.uuid, template); midiRegistry.track(parent.uuid, template); return template;
}

test("reference rewriting handles embedded IDs, synthetic actors and a single Sun/Moon pass", () => {
  const references = new Map([["Actor.sun", "Actor.moon"], ["Actor.sun.Item.old", "Actor.moon.Item.new"],
    ["Actor.moon.ActiveEffect.old", "Actor.moon.ActiveEffect.new"]]);
  const result = rewriteReferences({ item: { id: "old", uuid: "Actor.sun.Item.old" },
    text: "@Embed[Actor.sun.Item.old inline]", unrelated: "Actor.sunrise.Item.old" }, references);
  assert.equal(result.item.id, "new"); assert.equal(result.text, "@Embed[Actor.moon.Item.new inline]");
  assert.equal(result.unrelated, "Actor.sunrise.Item.old");
  assert.equal(rewriteReferences("Actor.sun.ActiveEffect.old", references), "Actor.moon.ActiveEffect.old");
});

test("concentration keeps duration, item/activity IDs, linked targets and templates across forms", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const sourceSpell = addSpell(sun, "spellSun", "castSun"), targetSpell = addSpell(moon, "spellMoon", "castMoon");
  const focus = await concentrate(sun, sourceSpell);
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "blessing", origin: sourceSpell.uuid, statuses: [],
    flags: { dnd5e: { dependentOn: focus.uuid }, dae: { token: "Scene.scene.Token.source" } } }]))[0];
  const scene = sceneMock(); game.scenes = [scene]; const template = templateMock(scene, focus, { actor: sun.uuid, item: sourceSpell.uuid });
  const duration = clone(focus.duration);
  await transferBattleState(sun, moon);
  const moved = moon.effects.get("focus");
  assert.equal(sun.concentration.effects.size, 0); assert.equal(moon.concentration.effects.size, 1);
  assert.deepEqual(moved.duration, duration); assert.equal(moved.origin, targetSpell.uuid);
  assert.equal(moved.flags.dnd5e.item.id, targetSpell.id); assert.equal(moved.flags.dnd5e.activity.id, "castMoon");
  assert.equal(moved.flags.dnd5e.activity.uuid, `${targetSpell.uuid}.Activity.castMoon`);
  assert.equal(buff.flags.dnd5e.dependentOn, moved.uuid); assert.equal(buff.origin, targetSpell.uuid);
  assert.equal(template.flags.dnd5e.dependentOn, moved.uuid); assert.equal(template.removed, false);
  assert.equal(nativeRegistry.get(focus).length, 0); assert.equal(midiRegistry.get(focus).length, 0);
  assert.ok(nativeRegistry.get(moved).includes(buff)); assert.ok(midiRegistry.get(moved).includes(template));
  await moon.endConcentration();
  assert.equal(ally.effects.size, 0); assert.equal(template.removed, true);
});

test("concentration absent from the other spell list remains active but cannot be cast again there", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); await concentrate(sun, spell);
  await transferBattleState(sun, moon);
  const anchor = moon.items.get(spell.id);
  assert.equal(anchor.flags[MODULE_ID].auriandriaCastAnchor, true);
  assert.equal(emitHook("dnd5e.preUseActivity", { item: anchor }), false);
  assert.equal(moon.concentration.effects.size, 1);
  await transferBattleState(moon, sun);
  assert.equal(moon.items.has(spell.id), false); assert.equal(sun.items.get(spell.id), spell);
  assert.equal(sun.concentration.effects.size, 1); assert.equal(sun.effects.get("focus").origin, spell.uuid);
  assert.notEqual(emitHook("dnd5e.preUseActivity", { item: spell }), false);
});

test("ending concentration also removes its temporary item when the spell is missing in the new form", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); await concentrate(sun, spell);
  await transferBattleState(sun, moon); await moon.endConcentration();
  assert.equal(moon.items.has(spell.id), false); assert.equal(moon.effects.size, 0); assert.equal(sun.items.has(spell.id), true);
});

test("disabled and ongoing effects retain timers and do not trigger rider creation during movement", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const effect = (await sun.createEmbeddedDocuments("ActiveEffect", [{ _id: "ongoing", name: "Кровотечение", disabled: true,
    statuses: ["bleeding"], duration: { seconds: 42, startTime: 60 },
    changes: [{ key: "flags.midi-qol.OverTime", value: "turn=start,damageRoll=1d4" }],
    flags: { dnd5e: { riders: { statuses: ["incapacitated"] } }, dae: { specialDuration: ["turnEndSource"] } }
  }]))[0];
  riderCalls = 0;
  await transferBattleState(sun, moon);
  const moved = moon.effects.get(effect.id);
  assert.equal(moved.disabled, true); assert.deepEqual(moved.duration, effect.duration);
  assert.deepEqual(moved.changes, effect.changes); assert.deepEqual(moved.flags.dae.specialDuration, ["turnEndSource"]);
  assert.equal(riderCalls, 0); assert.equal(sun.effects.size, 0);
});

test("temporary item enchantments move to the matching item without replacing permanent effects", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const mage = addActor(new ActorMock("mage", "sun")); const spell = addSpell(mage), focus = await concentrate(mage, spell);
  const weapon = (id, effects) => ({ _id: id, name: "Меч", type: "weapon", system: { identifier: "sword" }, effects });
  const sourceSword = sun.addItem(weapon("sourceSword", [{ _id: "permanent", name: "Свойство меча", flags: {}, statuses: [] },
    { _id: "magic", name: "Магическое оружие", type: "enchantment", origin: spell.uuid,
      flags: { dnd5e: { dependentOn: focus.uuid } }, duration: { seconds: 3600, startTime: 50 }, statuses: [] }]));
  const targetSword = moon.addItem(weapon("targetSword", [{ _id: "permanent", name: "Другое свойство меча", flags: {}, statuses: [] }]));
  await transferBattleState(sun, moon);
  assert.equal(sourceSword.effects.has("magic"), false); assert.equal(sourceSword.effects.has("permanent"), true);
  assert.equal(targetSword.effects.get("permanent").name, "Другое свойство меча");
  assert.equal(targetSword.effects.get("magic").origin, spell.uuid);
  await mage.endConcentration(); assert.equal(targetSword.effects.has("magic"), false); assert.equal(targetSword.effects.has("permanent"), true);
});

test("spell effect templates with an unstarted duration stay in their own forms", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spells = [sun, moon].map((actor, index) => {
    const form = index ? "moon" : "sun";
    const data = JSON.parse(fs.readFileSync(new URL(`../pack-src/auriandria/${form}.json`, import.meta.url), "utf8"));
    return actor.addItem(data.items.find(item => item.system?.identifier === "light"));
  });
  const snapshots = spells.map(spell => [...spell.effects].map(effect => effect.toObject()));
  assert.ok(snapshots.every(effects => effects.length > 0));
  for (const [source, target] of [[sun, moon], [moon, sun]]) {
    await transferBattleState(source, target);
    for (let i = 0; i < spells.length; i++) {
      assert.deepEqual([...spells[i].effects].map(effect => effect.toObject()), snapshots[i]);
    }
  }
});

test("previously moved spell templates return to their recorded owner once, without applying riders", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const source = addSpell(sun), destination = addSpell(moon);
  const template = { _id: "template", name: "Шаблон заклинания", type: "base", statuses: [],
    duration: { seconds: 60, startTime: null, startRound: null },
    changes: [{ key: "system.attributes.ac.bonus", value: "1" }],
    flags: { dnd5e: { riders: { statuses: ["incapacitated"] } } } };
  const data = clone(template); data._id = "moved";
  data.flags[MODULE_ID] = { auriandriaSharedEffect: true,
    auriandriaEffectKey: `${source.uuid}.ActiveEffect.${template._id}`, auriandriaMoving: false };
  await destination.createEmbeddedDocuments("ActiveEffect", [data]); riderCalls = 0;
  assert.equal(await restoreAuriandriaEffectTemplates(), 1);
  assert.equal(destination.effects.size, 0);
  const restored = source.effects.get("template");
  assert.deepEqual(restored.changes, template.changes); assert.deepEqual(restored.duration, template.duration);
  assert.equal(restored.flags[MODULE_ID].auriandriaSharedEffect, undefined);
  assert.equal(restored.flags[MODULE_ID].auriandriaMoving, undefined);
  assert.equal(riderCalls, 0); assert.equal(await restoreAuriandriaEffectTemplates(), 0);
});

test("template repair preserves edited originals and ignores started or dependent item effects", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const source = addSpell(sun), destination = addSpell(moon);
  await source.createEmbeddedDocuments("ActiveEffect", [{ _id: "template", name: "Правки игрока", flags: {}, statuses: [] }]);
  const data = { name: "Скопированный эффект", statuses: [], type: "base",
    duration: { seconds: 60, startTime: null }, flags: { [MODULE_ID]: { auriandriaSharedEffect: true,
      auriandriaEffectKey: `${source.uuid}.ActiveEffect.template` } } };
  await destination.createEmbeddedDocuments("ActiveEffect", [
    { ...clone(data), _id: "conflict" },
    { ...clone(data), _id: "started", duration: { seconds: 60, startTime: 0 } },
    { ...clone(data), _id: "dependent", flags: { ...clone(data.flags), dnd5e: { dependentOn: "Actor.mage.ActiveEffect.focus" } } }
  ]);
  assert.equal(await restoreAuriandriaEffectTemplates(), 0);
  assert.equal(source.effects.get("template").name, "Правки игрока"); assert.equal(destination.effects.size, 3);
});

test("a failed transfer restores external concentration links and never deletes the live targets", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); addSpell(moon); const focus = await concentrate(sun, spell);
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "buff", statuses: [], flags: { dnd5e: { dependentOn: focus.uuid } } }]))[0];
  const create = moon.createEmbeddedDocuments.bind(moon);
  moon.createEmbeddedDocuments = async (type, data, options) => { if (type === "ActiveEffect") throw new Error("Simulated write failure"); return create(type, data, options); };
  await assert.rejects(transferBattleState(sun, moon), /Simulated write failure/);
  assert.equal(buff.flags.dnd5e.dependentOn, focus.uuid); assert.equal(ally.effects.has("buff"), true);
  assert.equal(sun.concentration.effects.size, 1); assert.equal(moon.concentration.effects.size, 0);
  assert.ok(nativeRegistry.get(focus).includes(buff));
});

test("late failures restore the original concentration after its source-side record was removed", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); addSpell(moon); const focus = await concentrate(sun, spell);
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "buff", statuses: [], flags: { dnd5e: { dependentOn: focus.uuid } } }]))[0];
  sun.flags["midi-qol"] = { actions: { action: true } };
  const update = moon.update.bind(moon);
  moon.update = async (data, options) => { if (data["flags.midi-qol.actions"]) throw new Error("Late write failure"); return update(data, options); };
  await assert.rejects(transferBattleState(sun, moon), /Late write failure/);
  assert.equal(ally.effects.has("buff"), true); assert.equal(buff.flags.dnd5e.dependentOn, focus.uuid);
  assert.equal(sun.concentration.effects.size, 1); assert.equal(moon.concentration.effects.size, 0);
});

test("inactive sheets cannot overwrite the battle state of the current form", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  sun.flags[MODULE_ID].auriandriaActiveActor = moon.uuid;
  await assert.rejects(performTransformation({ userId: "player", actorUuid: sun.uuid,
    itemUuid: [...sun.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition).uuid,
    targetUuid: moon.uuid }), /неактивна/);
});

test("a form switch from an unlinked token preserves concentration and replaces synthetic UUIDs", async () => {
  const base = addActor(new ActorMock("base", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const scene = sceneMock(); game.scenes = [scene];
  const token = tokenMock(scene, "source", base, 0, 1);
  const synthetic = new ActorMock("synthetic", "sun"); synthetic.isToken = true; synthetic.token = token;
  synthetic.id = base.id; synthetic.uuid = `Scene.${scene.id}.Token.${token.id}.Actor.${base.id}`; docs.set(synthetic.uuid, synthetic);
  for (const item of synthetic.items) {
    item.uuid = `${synthetic.uuid}.Item.${item.id}`; docs.set(item.uuid, item);
  }
  token.actorLink = false;
  Object.defineProperty(token, "actor", { get() { return this.actorLink ? game.actors.get(this.actorId) : synthetic; } });
  const spell = addSpell(synthetic), focus = await concentrate(synthetic, spell);
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "buff", statuses: [], origin: spell.uuid,
    flags: { dnd5e: { dependentOn: focus.uuid } } }]))[0];
  const item = [...synthetic.items].find(item => item.flags?.[MODULE_ID]?.auriandriaTransition === "moon");
  await performTransformation({ userId: "player", actorUuid: synthetic.uuid, itemUuid: item.uuid, targetUuid: moon.uuid, tokenUuid: token.uuid });
  assert.equal(token.actor.uuid, moon.uuid); assert.equal(token.id, "source");
  assert.equal(synthetic.effects.size, 0); assert.equal(moon.concentration.effects.size, 1);
  assert.equal(buff.flags.dnd5e.dependentOn, `${moon.uuid}.ActiveEffect.focus`);
  assert.equal(buff.origin, `${moon.uuid}.Item.${spell.id}`);
  await moon.endConcentration(); assert.equal(ally.effects.size, 0);
});

test("rollback restores dependency links between effects that were both removed from the source", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); addSpell(moon); const focus = await concentrate(sun, spell);
  await sun.createEmbeddedDocuments("ActiveEffect", [{ _id: "selfBuff", statuses: [], flags: { dnd5e: { dependentOn: focus.uuid } } }]);
  sun.flags["midi-qol"] = { actions: { action: true } };
  const update = moon.update.bind(moon);
  moon.update = async (data, options) => { if (data["flags.midi-qol.actions"]) throw new Error("Late write failure"); return update(data, options); };
  await assert.rejects(transferBattleState(sun, moon), /Late write failure/);
  assert.equal(sun.effects.get("selfBuff").flags.dnd5e.dependentOn, focus.uuid);
  await sun.endConcentration(); assert.equal(sun.effects.has("selfBuff"), false);
});

test("legacy inactive copies reattach their dependents to the concentration in the current form", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const sunSpell = addSpell(sun), moonSpell = addSpell(moon);
  const legacy = await concentrate(sun, sunSpell, "oldFocus");
  await legacy.update({ [`flags.${MODULE_ID}.auriandriaSharedEffect`]: true });
  const current = await concentrate(moon, moonSpell, "newFocus");
  const ally = addActor(new ActorMock("ally", "sun"));
  const buff = (await ally.createEmbeddedDocuments("ActiveEffect", [{ _id: "buff", statuses: [], flags: { dnd5e: { dependentOn: legacy.uuid } } }]))[0];
  await transferBattleState(moon, sun);
  assert.equal(sun.effects.has("oldFocus"), false); assert.equal(sun.effects.has("newFocus"), true);
  assert.equal(buff.flags.dnd5e.dependentOn, `${sun.uuid}.ActiveEffect.${current.id}`);
  await sun.endConcentration(); assert.equal(ally.effects.has("buff"), false);
});

test("concentration chat cards follow remapped effect IDs without altering historical cards", async () => {
  const sun = addActor(new ActorMock("sun", "sun")), moon = addActor(new ActorMock("moon", "moon"));
  const spell = addSpell(sun); addSpell(moon); await concentrate(sun, spell);
  await moon.createEmbeddedDocuments("ActiveEffect", [{ _id: "focus", name: "Постоянное свойство формы", statuses: [], flags: {} }]);
  const card = { uuid: "ChatMessage.card", speaker: { actor: sun.id }, system: { concentration: "focus" },
    flags: { dnd5e: { item: { id: spell.id, uuid: spell.uuid } } }, async update(changes) { merge(this, changes); } };
  const history = { uuid: "ChatMessage.history", speaker: { actor: sun.id }, system: {}, flags: {}, async update() { throw new Error("History must not change"); } };
  game.messages = [card, history]; docs.set(card.uuid, card);
  await transferBattleState(sun, moon);
  assert.equal(card.speaker.actor, moon.id); assert.notEqual(card.system.concentration, "focus");
  assert.equal(moon.effects.get(card.system.concentration).statuses.has("concentrating"), true);
  assert.equal(moon.effects.get("focus").name, "Постоянное свойство формы");
});

test("libWrapper chains existing handlers without prototype reassignment or duplicate guards", async () => {
  const originalConfig = CONFIG;
  const registrations = new Map(), existingCalls = [], nativeCalls = [];
  class CompatibleEffect {}
  class CompatibleActor {}
  const paths = [
    ["ActiveEffect", CompatibleEffect, "getDependents", false],
    ["ActiveEffect", CompatibleEffect, "createRiderConditions", true],
    ["ActiveEffect", CompatibleEffect, "createRiderEnchantments", true],
    ["Actor", CompatibleActor, "endConcentration", true]
  ];
  for (const [type, Class, method, asyncResult] of paths) {
    const path = `CONFIG.${type}.documentClass.prototype.${method}`;
    const native = function(...args) {
      nativeCalls.push({ method, receiver: this, args });
      return asyncResult ? Promise.resolve(["native"]) : ["native"];
    };
    // Like an existing libWrapper WRAPPER, this handler stays outside MIXED guards.
    Object.defineProperty(Class.prototype, method, {
      get() { return function(...args) {
        existingCalls.push(method);
        const wrapper = registrations.get(path);
        return wrapper ? wrapper.call(this, native.bind(this), ...args) : native.apply(this, args);
      }; },
      set() { throw new Error(`Direct reassignment conflicts with existing handlers: ${method}`); }
    });
  }
  globalThis.CONFIG = { ...CONFIG, Actor: { documentClass: CompatibleActor }, ActiveEffect: { documentClass: CompatibleEffect } };
  globalThis.libWrapper = { register(packageId, path, fn, type) {
    assert.equal(packageId, MODULE_ID); assert.equal(type, "MIXED");
    assert.equal(registrations.has(path), false); registrations.set(path, fn);
  } };
  try {
    registerAuriandriaState(); registerAuriandriaState();
    assert.equal(registrations.size, 4);
    const effect = new CompatibleEffect(), actor = new CompatibleActor(); effect.flags = {};
    for (const [type, , method] of paths) {
      const receiver = type === "Actor" ? actor : effect;
      assert.deepEqual(await receiver[method](effect, "argument"), ["native"]);
      const call = nativeCalls.at(-1);
      assert.equal(call.receiver, receiver); assert.deepEqual(call.args, [effect, "argument"]);
    }
    effect.flags[MODULE_ID] = { auriandriaMoving: true };
    for (const [type, , method] of paths) {
      assert.deepEqual(await (type === "Actor" ? actor : effect)[method](effect), []);
    }
    assert.equal(nativeCalls.length, 4); assert.equal(existingCalls.length, 8);
    effect.flags[MODULE_ID].auriandriaMoving = false;
    assert.deepEqual(await actor.endConcentration(effect), ["native"]);
    assert.equal(nativeCalls.length, 5);
  } finally { globalThis.CONFIG = originalConfig; delete globalThis.libWrapper; }
});

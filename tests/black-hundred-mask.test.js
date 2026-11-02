import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import fs from "node:fs";
import { MODULE_ID, PACK_ENTRIES } from "../scripts/lib/identifier.js";
import {
  activeSymbols, automationTier, characterLevel, MASK_ID, MASK_STATE, maskEffectData,
  maskState, symbolDescription, symbolSlots, SYMBOLS, WILL_ID
} from "../scripts/items/black-hundred-mask/data.js";
import { applySymbols, markMagicalAttacks, registerBlackHundredMask, syncMask } from "../scripts/items/black-hundred-mask/index.js";
import { canHeal, currentTurn, hitDieChoices, regenerateWill, useWill } from "../scripts/items/black-hundred-mask/will.js";
import { chooseSymbols, selectionContent } from "../scripts/items/black-hundred-mask/dialog.js";
const clone = value => JSON.parse(JSON.stringify(value));
function set(object, path, value) {
  const keys = path.split("."); let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  const last = keys.at(-1);
  if (last.startsWith("-=")) delete target[last.slice(2)];
  else target[last] = clone(value);
}
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
let id = 0, rolls, messages, dialogConfig;
const handlers = new Map();
globalThis.Hooks = { on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.foundry = {
  utils: { escapeHTML: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') },
  applications: { api: { DialogV2: {
    async wait(config) { dialogConfig = config; return null; },
    async prompt() { return null; }
  } } }
};
globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor.id }), async create(data) { messages.push(data); } };
globalThis.Roll = class {
  constructor(formula, data) { this.formula = formula; this.data = data; rolls.push(this); }
  async evaluate() {
    this.total = Math.max(0, 4 + this.data.abilities.con.mod + (this.formula.includes("@abilities.int.mod") ? this.data.abilities.int.mod : 0));
    return this;
  }
  async toMessage(data) { messages.push(data); }
};
class Doc {
  constructor(data, actor) { Object.assign(this, clone(data)); this.id = data._id ?? `doc${id++}`; this.actor = actor; this.uuid = `${actor.uuid}.Item.${this.id}`; }
  async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); return this; }
}
class Actor {
  constructor(level, hp = 10, max = 40) {
    this.id = `actor${id++}`; this.uuid = `Actor.${this.id}`; this.isOwner = true; this.flags = {};
    this.system = { details: { level }, attributes: { hp: { value: hp, max, tempmax: 0 } }, abilities: { int: { mod: 2 }, con: { mod: 3 } } };
    this.effects = new Collection(); this.items = new Collection();
    this.cls = new Doc({ name: "Воин", type: "class", system: { levels: level, hd: { denomination: "d10", value: level, spent: 0 } } }, this);
    this.items.set(this.cls.id, this.cls);
    this.mask = new Doc({ name: "Маска", img: "mask.svg", type: "equipment", system: { identifier: MASK_ID, equipped: true } }, this);
    this.items.set(this.mask.id, this.mask);
    this.writes = 0;
  }
  get itemTypes() { return { class: [...this.items].filter(item => item.type === "class") }; }
  getRollData() { return clone(this.system); }
  testUserPermission() { return true; }
  async update(changes) { this.writes++; for (const [path, value] of Object.entries(changes)) set(this, path, value); return this; }
  async createEmbeddedDocuments(type, entries) {
    if (type === "Item" && this.failFeature) { this.failFeature = false; throw new Error("Feature creation failed"); }
    return entries.map(data => { const doc = new Doc(data, this); (type === "Item" ? this.items : this.effects).set(doc.id, doc); this.writes++; return doc; });
  }
  async deleteEmbeddedDocuments(type, ids) { for (const id of ids) (type === "Item" ? this.items : this.effects).delete(id); this.writes++; }
  async applyDamage(damages) {
    if (this.failHealing) throw new Error("Healing failed");
    const hp = this.system.attributes.hp;
    hp.value = Math.min(hp.max + hp.tempmax, hp.value + damages[0].value);
  }
}
function combatFor(actor, own = true) {
  const combat = { id: "combat", uuid: "Combat.combat", started: true, round: 1, turn: own ? 0 : 1,
    combatants: [{ actor }], combatant: { actor: own ? actor : { uuid: "Actor.other" } } };
  game.combat = combat; game.combats = [combat]; return combat;
}
registerBlackHundredMask();
beforeEach(() => {
  rolls = []; messages = []; dialogConfig = null;
  globalThis.game = { user: { id: "gm", isGM: true }, users: { activeGM: { id: "gm" } }, combat: null, combats: [] };
});

test("slots and tiers cover boundaries, total multiclass levels and capped automation", () => {
  assert.deepEqual([1, 3, 4, 8, 9, 15, 16, 20].map(symbolSlots), [1, 1, 2, 2, 3, 3, 3, 3]);
  for (const [level, tier] of [[1, 1], [2, 1], [3, 3], [5, 3], [6, 6], [9, 6], [10, 10], [14, 10], [20, 10]]) {
    assert.equal(automationTier(new Actor(level)), tier);
  }
  const actor = new Actor(6);
  actor.items.set("second", new Doc({ type: "class", system: { levels: 4 } }, actor));
  assert.equal(characterLevel(actor), 10);
});
test("compendium source is in Items, contains all original tiers and one-sentence chat", () => {
  const entry = PACK_ENTRIES.find(entry => entry.folderName === "Предметы");
  const data = JSON.parse(fs.readFileSync(new URL("../pack-src/items/black-hundred-mask.json", import.meta.url)));
  assert.equal(data._id, entry.itemId); assert.equal(data.name, "Маска черной сотни");
  assert.equal(data.type, "equipment"); assert.equal(data.system.description.chat.match(/[.!?]/g).length, 1);
  assert.match(data.system.description.value, /Высшее восстановление/);
  for (const symbol of Object.values(SYMBOLS)) for (const tier of Object.keys(symbol.levels)) {
    assert.ok(data.system.description.value.includes(`${tier} уровень`));
  }
  for (const value of [entry.folderId, data._id, ...Object.keys(data.system.activities)]) assert.match(value, /^[a-zA-Z0-9]{16}$/);
});
test("current-level tooltips, slot count, no duplicate selections and cancelling the dialog", async () => {
  const actor = new Actor(9);
  const html = selectionContent(actor, actor.mask);
  assert.equal((html.match(/class="mask-symbol-dropdown"/g) ?? []).length, 3);
  assert.match(html, /data-tooltip="\+5 урона/); assert.match(html, /role="listbox"/);
  assert.match(symbolDescription("shield", 10), /вместо фиксированного/);
  assert.match(symbolDescription("sword", 17), /всем противникам/);
  assert.match(symbolDescription("sword", 17), /Автоматизация ограничена/);
  assert.equal(await chooseSymbols(actor, actor.mask), null); assert.equal(actor.effects.size, 0);
  await assert.rejects(applySymbols(actor.mask, ["sword", "sword"]), /разные/);
  await assert.rejects(applySymbols(actor.mask, ["unknown"]), /разные/);
  await assert.rejects(applySymbols(new Actor(1).mask, ["sword", "shield"]), /разные/);
});
test("sword and shield use exact tier bonuses; level ten replaces flat AC with INT", () => {
  for (const [level, damage, ac] of [[1, "1", "1"], [3, "3", "2"], [6, "5", "3"], [10, "7", "@abilities.int.mod"], [17, "7", "@abilities.int.mod"]]) {
    const actor = new Actor(level);
    const changes = maskEffectData(actor, actor.mask, ["sword", "shield"]).changes;
    assert.deepEqual(changes.map(change => change.key), ["system.bonuses.mwak.damage", "system.bonuses.rwak.damage", "system.attributes.ac.bonus"]);
    assert.deepEqual(changes.map(change => change.value), [`${damage}[Символ Меча]`, `${damage}[Символ Меча]`, ac]);
  }
});
test("symbols can be changed at any time despite a legacy rest lock, and cleared completely", async () => {
  const actor = new Actor(6);
  await applySymbols(actor.mask, ["sword", "shield"]);
  assert.equal(actor.effects.size, 1); assert.equal(messages.length, 1);
  await actor.update({ [`flags.${MODULE_ID}.${MASK_STATE}.selectionAvailable`]: false });
  await chooseSymbols(actor, actor.mask);
  assert.deepEqual(dialogConfig.buttons.map(button => button.action), ["apply", "clear", "cancel"]);
  await applySymbols(actor.mask, ["will"]); assert.equal(actor.effects.size, 1);
  assert.deepEqual(activeSymbols(actor), ["will"]);
  assert.equal([...actor.items].filter(item => item.system.identifier === WILL_ID).length, 1);
  const clear = dialogConfig.buttons.find(button => button.action === "clear");
  await applySymbols(actor.mask, clear.callback());
  assert.deepEqual(maskState(actor).symbols, []); assert.deepEqual(activeSymbols(actor), []);
  assert.equal(actor.effects.size, 0);
  assert.equal([...actor.items].filter(item => item.system.identifier === WILL_ID).length, 0);
  await applySymbols(actor.mask, ["shield"]); assert.deepEqual(activeSymbols(actor), ["shield"]);
  actor.mask.system.equipped = false;
  await applySymbols(actor.mask, []); assert.deepEqual(maskState(actor).symbols, []);
  assert.equal(actor.effects.size, 0);
});
test("synchronization is idempotent, follows class level, removes bonuses on unequip or deletion", async () => {
  const actor = new Actor(5);
  await applySymbols(actor.mask, ["will", "shield"]);
  let writes = actor.writes; await Promise.all([syncMask(actor), syncMask(actor)]); assert.equal(actor.writes, writes);
  assert.equal([...actor.items].filter(item => item.system.identifier === WILL_ID).length, 0);
  actor.cls.system.levels = 6; await syncMask(actor);
  assert.equal([...actor.items].filter(item => item.system.identifier === WILL_ID).length, 1);
  assert.equal([...actor.effects][0].flags[MODULE_ID].tier, 6);
  actor.cls.system.levels = 10; await syncMask(actor);
  assert.match([...actor.items].find(item => item.system.identifier === WILL_ID).system.description.value, /Интеллекта/);
  actor.mask.system.equipped = false; await syncMask(actor);
  assert.equal(actor.effects.size, 0); assert.deepEqual(activeSymbols(actor), []);
  assert.equal([...actor.items].filter(item => item.system.identifier === WILL_ID).length, 0);
  actor.mask.system.equipped = true; await syncMask(actor); assert.equal(actor.effects.size, 1);
  actor.items.delete(actor.mask.id); await syncMask(actor); assert.equal(actor.effects.size, 0);
});
test("failed first selection restores the empty state and removes partial effects", async () => {
  const actor = new Actor(6); actor.failFeature = true;
  await assert.rejects(applySymbols(actor.mask, ["will"]), /Feature creation failed/);
  assert.deepEqual(maskState(actor), {}); assert.equal(actor.effects.size, 0);
  await applySymbols(actor.mask, ["will"]); assert.equal(actor.effects.size, 1);
  const another = new Actor(6);
  await applySymbols(another.mask, ["sword"]);
  another.failFeature = true;
  await assert.rejects(applySymbols(another.mask, ["will"]), /Feature creation failed/);
  assert.deepEqual(activeSymbols(another), ["sword"]);
});
test("magical attacks start at six, affect all attack damage parts, preserve properties and never grant advantage", async () => {
  for (const level of [3, 6, 10]) {
    const actor = new Actor(level); await applySymbols(actor.mask, ["sword"]);
    for (const type of ["attack", "save"]) for (const index of [0, 1]) {
      const config = { options: { properties: ["sil"] } };
      markMagicalAttacks({ subject: { actor, type } }, config, index);
      markMagicalAttacks({ subject: { actor, type } }, config, index);
      assert.deepEqual(config.options.properties, level >= 6 && type === "attack" ? ["sil", "mgc"] : ["sil"]);
      assert.equal(config.options.advantage, undefined);
    }
    [...actor.effects][0].disabled = true;
    const config = {}; markMagicalAttacks({ subject: { actor, type: "attack" } }, config); assert.deepEqual(config, {});
  }
});
test("regeneration heals 3/5 only below half and above zero; one heal per turn across duplicate events", async () => {
  for (const [level, heal] of [[1, 3], [3, 5], [5, 5], [6, 0]]) {
    const actor = new Actor(level); await applySymbols(actor.mask, ["will"]);
    const combat = combatFor(actor);
    await Promise.all([regenerateWill(combat), regenerateWill(combat)]); await regenerateWill(combat);
    assert.equal(actor.system.attributes.hp.value, 10 + heal);
  }
  for (const hp of [0, 20, 30]) {
    const actor = new Actor(3, hp); await applySymbols(actor.mask, ["will"]);
    await regenerateWill(combatFor(actor)); assert.equal(actor.system.attributes.hp.value, hp);
  }
  const actor = new Actor(3, 19); await applySymbols(actor.mask, ["will"]);
  await regenerateWill(combatFor(actor)); assert.equal(actor.system.attributes.hp.value, 24);
});
test("level six spends one chosen hit die, adds CON and enforces own turn and once per turn", async () => {
  const actor = new Actor(6); await applySymbols(actor.mask, ["will"]);
  const combat = combatFor(actor, false);
  await assert.rejects(useWill(actor), /свой ход/); assert.equal(rolls.length, 0);
  combat.turn = 0; combat.combatant.actor = actor;
  await Promise.all([useWill(actor), useWill(actor)]);
  assert.equal(rolls.length, 1); assert.equal(actor.cls.system.hd.spent, 1);
  assert.equal(actor.system.attributes.hp.value, 17); assert.doesNotMatch(rolls[0].formula, /int/);
  await assert.rejects(useWill(actor), /уже использован/);
  combat.round = 2; await useWill(actor); assert.equal(actor.cls.system.hd.spent, 2);
});
test("level ten adds CON and INT, does not spend dice, and works even when all dice have been spent", async () => {
  const actor = new Actor(10); actor.cls.system.hd = { denomination: "d10", value: 0, spent: 10 };
  await applySymbols(actor.mask, ["will"]); combatFor(actor);
  await useWill(actor);
  assert.equal(actor.system.attributes.hp.value, 19); assert.equal(actor.cls.system.hd.spent, 10);
  assert.match(rolls[0].formula, /@abilities.con.mod \+ @abilities.int.mod/);
});
test("Will rejects no dice, half health, zero, disabled effect, and rolls back a failed heal", async () => {
  const actor = new Actor(6); await applySymbols(actor.mask, ["will"]); combatFor(actor);
  actor.cls.system.hd.value = 0; await assert.rejects(useWill(actor), /Нет доступных/);
  actor.cls.system.hd.value = 6;
  for (const hp of [0, 20]) { actor.system.attributes.hp.value = hp; assert.equal(canHeal(actor), false); await assert.rejects(useWill(actor), /ПЗ выше/); }
  actor.system.attributes.hp.value = 10; actor.failHealing = true;
  await assert.rejects(useWill(actor), /Healing failed/);
  assert.equal(actor.cls.system.hd.spent, 0); assert.equal(maskState(actor).willTurn, null);
  actor.failHealing = false; await useWill(actor); assert.equal(actor.cls.system.hd.spent, 1);
  [...actor.effects][0].disabled = true; await assert.rejects(useWill(actor), /не активен/);
});
test("multiclass die choices preserve class identity and unrelated combat does not block healing", () => {
  const actor = new Actor(6);
  actor.items.set("wizard", new Doc({ _id: "wizard", name: "Маг", type: "class", system: { levels: 4, hd: { denomination: "d6", value: 0, spent: 4 } } }, actor));
  assert.deepEqual(hitDieChoices(actor, true).map(choice => choice.die), ["d10"]);
  assert.deepEqual(hitDieChoices(actor, false).map(choice => choice.die), ["d10", "d6"]);
  combatFor(new Actor(1)); assert.equal(currentTurn(actor), null);
});

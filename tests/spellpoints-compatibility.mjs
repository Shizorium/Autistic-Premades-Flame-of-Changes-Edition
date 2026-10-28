// Optional check against the installed Advanced Magic module's actual class.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { installSpellPointsAdapter } from "../scripts/auriandria/spellpoints.js";
import { MODULE_ID } from "../scripts/lib/identifier.js";

const callbacks = new Map();
globalThis.Hooks = { on: (name, callback) => callbacks.set(name, callback) };
globalThis.SP_MODULE_NAME = "dnd5e-spellpoints";
globalThis.SP_ITEM_ID = "LUSjG8364p7LFY1u";
globalThis.foundry = { utils: {
  getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
  mergeObject: (first, second) => ({ ...first, ...second })
} };
globalThis.CONFIG = { DND5E: { spellProgression: { full: "Full" } } };
globalThis.game = {
  i18n: { format: key => key },
  settings: { get: () => ({ spResource: "Spell Points", spellPointsCosts: { 0: 0, 1: 2, 2: 3 } }) }
};
globalThis.ui = { notifications: { warn: () => {}, error: message => { throw new Error(message); } } };
let source = fs.readFileSync(process.argv[2], "utf8").replace(/^import .*?;\r?\n/gm, "");
source = source.replace("export class SpellPoints", "globalThis.SpellPoints = class SpellPoints");
vm.runInThisContext(source, { filename: "installed-spellpoints.js" });

const points = { id: "newId", type: "feat", system: { source: { custom: "Spell Points" }, uses: { max: 17, spent: 7 } }, flags: {} };
const items = [points]; items.get = id => items.find(item => item.id === id);
const actor = { type: "character", items, collections: { items }, flags: {
  dnd5espellpoints: { item: "oldId" }, [MODULE_ID]: { auriandriaForm: "sun" }
}, system: { spells: {} } };
assert.equal(SpellPoints.getSpellPointsItem(actor), points);

const activity = { isSpell: true, actor, item: { system: { level: 1 } }, consumption: { spellSlot: true } };
const config = { hasConsumption: true, consume: { spellSlot: true } };
SpellPoints.checkPreUseActivity(activity, config, { applicationClass: { DEFAULT_OPTIONS: { classes: [] } } }, {});
assert.equal(config.consume.spellPoints, true);
assert.equal(config.consume.spellSlot, false);
assert.equal(config.spellPointsItem, points);
installSpellPointsAdapter(SpellPoints);
installSpellPointsAdapter(SpellPoints);
// The native async side effect is skipped; the awaited system update carries the cost.
assert.equal(SpellPoints.castSpell(activity, config, {}), undefined);
const updates = { item: [], actor: {} };
callbacks.get("dnd5e.activityConsumption")(activity, config, { data: { flags: { dnd5e: { use: { spellLevel: 2 } } } } }, updates);
assert.equal(updates.item.length, 1);
assert.equal(updates.item[0]._id, "newId");
assert.equal(updates.item[0]["system.uses.spent"], 10);
assert.equal(points.system.uses.spent, 7);
console.log("Installed spellpoints adapter: stale IDs, native usage dialog, upcasting and single consumption passed.");

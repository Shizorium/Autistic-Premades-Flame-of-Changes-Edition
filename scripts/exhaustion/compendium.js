import { MODULE_ID, PACK_NAME } from "../lib/identifier.js";
import {
  EXHAUSTION_ICON, exhaustionConfig, exhaustionDescription, exhaustionEffectData,
  exhaustionPenalty, isExhaustionPreset
} from "./config.js";

export const EXHAUSTION_FOLDER_ID = "apfceExhaustFld1";
let pending = Promise.resolve();

export function exhaustionPresetData(level, config = exhaustionConfig()) {
  return {
    _id: `apfceExhaust${String(level).padStart(4, "0")}`,
    name: level ? `Истощение ${level} (−${exhaustionPenalty(level, config)} к d20)` : "Истощение 0 — снять",
    type: "feat", img: EXHAUSTION_ICON, folder: EXHAUSTION_FOLDER_ID, sort: level * 10000,
    system: {
      description: { value: `<p>Перетащите эту запись на лист персонажа или НИП: ${level ? `истощение станет ${level}` : "истощение будет снято"}. Предыдущий эффект заменяется, а запись не остаётся в особенностях персонажа.</p>${exhaustionDescription(level, config)}` },
      identifier: `apfce-exhaustion-${level}`, type: { value: "", subtype: "" },
      source: { custom: "Flame of Changes — Истощение", rules: "2014" }
    },
    effects: level ? [{
      ...exhaustionEffectData(level, { config }), _id: "apfceExhaustEff1"
    }] : [],
    flags: { [MODULE_ID]: { exhaustionPreset: true, exhaustionLevel: level, exhaustionPresetVersion: 1 } },
    ownership: { default: 2 }
  };
}

export function ensureExhaustionPack() {
  pending = pending.catch(() => {}).then(updatePack);
  return pending;
}

async function updatePack() {
  if (game.users.activeGM?.id !== game.user.id) return;
  const pack = game.packs.get(`${MODULE_ID}.${PACK_NAME}`);
  if (!pack) return;
  const config = exhaustionConfig();
  const documents = await pack.getDocuments();
  const existing = new Map(documents.map(item => [item.id, item]));
  const create = [], update = [];
  for (let level = 0; level <= config.maxLevel; level++) {
    const data = exhaustionPresetData(level, config);
    const item = existing.get(data._id);
    if (!item) create.push(data);
    else {
      const source = item.toObject();
      if (["name", "folder", "sort"].some(key => source[key] !== data[key])
        || source.system.description.value !== data.system.description.value
        || source.flags?.[MODULE_ID]?.exhaustionPresetVersion !== 1
        || JSON.stringify(source.effects.map(e => ({ name: e.name, description: e.description })))
          !== JSON.stringify(data.effects.map(e => ({ name: e.name, description: e.description })))) update.push(data);
    }
  }
  const remove = documents.filter(item => isExhaustionPreset(item)
    && item.flags[MODULE_ID].exhaustionLevel > config.maxLevel).map(item => item.id);
  const folder = pack.folders.get(EXHAUSTION_FOLDER_ID);
  if (folder && !create.length && !update.length && !remove.length) return;
  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });
    if (pack.locked) throw new Error(`${pack.collection} is locked`);
    if (!folder) await Folder.create({
      _id: EXHAUSTION_FOLDER_ID, name: "Истощение", type: "Item", sorting: "m", color: "#725248"
    }, { pack: pack.collection, keepId: true });
    if (create.length) await Item.createDocuments(create, { pack: pack.collection, keepId: true });
    if (update.length) await Item.updateDocuments(update, { pack: pack.collection });
    if (remove.length) await Item.deleteDocuments(remove, { pack: pack.collection });
  } finally {
    if (wasLocked && !pack.locked) await pack.configure({ locked: true });
  }
}

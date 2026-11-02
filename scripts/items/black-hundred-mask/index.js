import { MODULE_ID } from "../../lib/identifier.js";
import {
  activeSymbols, automationTier, characterLevel, isMask, isWill, MASK_STATE,
  maskEffectData, maskState, selectedMask, SYMBOLS, symbolSlots, willFeatureData
} from "./data.js";
import { chooseSymbols } from "./dialog.js";
import { regenerateWill, useWill } from "./will.js";

const syncing = new Map(), choosing = new Set();
let registered = false;
function report(error) {
  console.error(`${MODULE_ID} | Black Hundred mask`, error);
  ui.notifications.error(`Маска чёрной сотни: ${error.message}`);
}
const safely = promise => { void promise.catch(report); };
export function isAuthority(actor) {
  const gm = game.users.activeGM;
  if (gm) return gm.id === game.user.id;
  return [...game.users].filter(user => user.active && actor.testUserPermission(user, "OWNER"))
    .sort((a, b) => a.id.localeCompare(b.id))[0]?.id === game.user.id;
}

export function registerBlackHundredMask() {
  if (registered) return;
  registered = true;
  // Replace the ordinary usage card with the picker; cancelling produces no chat message or resource use.
  Hooks.on("dnd5e.preUseActivity", activity => {
    if (!isMask(activity.item) && !isWill(activity.item)) return;
    if (activity.actor?.isOwner) safely(isMask(activity.item) ? useBlackHundredMask(activity.item) : useWill(activity.actor));
    return false;
  });
  Hooks.on("dnd5e.postBuildDamageRollConfig", markMagicalAttacks);
  for (const event of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(event, (item, ...args) => {
      const userId = args.at(-1);
      if (userId !== game.user.id || !item.actor?.isOwner || (!isMask(item) && item.type !== "class")) return;
      safely(syncMask(item.actor));
    });
  }
  Hooks.on("updateActor", (actor, changes, _options, userId) => {
    if (userId === game.user.id && actor.isOwner && (changes.system?.details || "system.details.level" in changes)) safely(syncMask(actor));
  });
  Hooks.on("updateCombat", (combat, changes) => {
    const actor = combat.combatant?.actor;
    if (actor && ("round" in changes || "turn" in changes) && isAuthority(actor)) safely(regenerateWill(combat));
  });
}

export function markMagicalAttacks(process, config) {
  const activity = config.subject ?? process.subject;
  if (activity?.type !== "attack" || !activeSymbols(activity.actor).includes("sword") || automationTier(activity.actor) < 6) return;
  config.options ??= {};
  const properties = new Set(config.options.properties ?? []);
  properties.add("mgc");
  config.options.properties = [...properties];
}

export function syncMask(actor) {
  const previous = syncing.get(actor.uuid) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => synchronize(actor));
  syncing.set(actor.uuid, task);
  void task.finally(() => { if (syncing.get(actor.uuid) === task) syncing.delete(actor.uuid); }).catch(() => {});
  return task;
}
async function synchronize(actor) {
  if (!actor?.isOwner) return;
  const item = selectedMask(actor), state = maskState(actor);
  const symbols = item ? [...new Set((state.symbols ?? []).filter(symbol => Object.hasOwn(SYMBOLS, symbol)))].slice(0, symbolSlots(characterLevel(actor))) : [];
  const effects = [...(actor.effects ?? [])].filter(effect => effect.flags?.[MODULE_ID]?.blackHundredMaskEffect);
  if (symbols.length) {
    const data = maskEffectData(actor, item, symbols), effect = effects.shift();
    if (!effect) await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    else if (effect.origin !== data.origin || effect.name !== data.name
      || JSON.stringify(effect.changes) !== JSON.stringify(data.changes)
      || JSON.stringify(effect.flags?.[MODULE_ID]) !== JSON.stringify(data.flags[MODULE_ID])) {
      await effect.update(data);
    }
  }
  if (effects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
  const features = [...actor.items].filter(isWill);
  if (symbols.includes("will") && automationTier(actor) >= 6) {
    const data = willFeatureData(actor), feature = features.shift();
    if (!feature) await actor.createEmbeddedDocuments("Item", [data]);
    else if (feature.system.description.value !== data.system.description.value) await feature.update({ "system.description": data.system.description });
  }
  if (features.length) await actor.deleteEmbeddedDocuments("Item", features.map(feature => feature.id));
}

export async function applySymbols(item, symbols) {
  const actor = item.actor;
  if (!actor?.isOwner || !isMask(item)) return;
  if (!Array.isArray(symbols) || symbols.some(symbol => !Object.hasOwn(SYMBOLS, symbol))
    || new Set(symbols).size !== symbols.length || symbols.length > symbolSlots(characterLevel(actor))) {
    throw new Error("Выберите разные известные символы в пределах доступного количества.");
  }
  const previous = { ...maskState(actor) };
  const prefix = `flags.${MODULE_ID}.${MASK_STATE}`;
  const selection = { itemId: item.id, symbols };
  await actor.update(Object.fromEntries(Object.entries(selection).map(([key, value]) => [`${prefix}.${key}`, value])));
  try { await syncMask(actor); }
  catch (error) {
    // Document updates merge objects: explicitly remove keys absent before the first selection.
    await actor.update(Object.fromEntries(Object.keys(selection).map(key => Object.hasOwn(previous, key)
      ? [`${prefix}.${key}`, previous[key]] : [`${prefix}.-=${key}`, null])));
    await syncMask(actor);
    throw error;
  }
  const names = symbols.map(symbol => SYMBOLS[symbol].name).join(", ");
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: symbols.length
    ? `<p>На маске чёрной сотни выбраны символы: ${names}.</p>`
    : "<p>Все символы маски чёрной сотни сняты.</p>" });
}

export async function useBlackHundredMask(item) {
  const actor = item?.actor;
  if (!isMask(item) || !actor?.isOwner || choosing.has(actor.uuid)) return;
  choosing.add(actor.uuid);
  try {
    const symbols = await chooseSymbols(actor, item);
    if (Array.isArray(symbols)) await applySymbols(item, symbols);
  } finally { choosing.delete(actor.uuid); }
}

export async function readyBlackHundredMask() {
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const scene of game.scenes ?? []) for (const token of scene.tokens ?? []) {
    if (!token.actorLink && token.actor) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) if (isAuthority(actor)) {
    try { await syncMask(actor); } catch (error) { report(error); }
  }
}

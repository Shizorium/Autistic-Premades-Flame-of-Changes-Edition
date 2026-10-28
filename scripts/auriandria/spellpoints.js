import { MODULE_ID } from "../lib/identifier.js";
import { formOf, transitionOf } from "./data.js";

const DEFAULT_COSTS = [0, 2, 3, 5, 6, 7, 9, 10, 11, 13];

export function isAuriandria(actor) {
  return Boolean(formOf(actor)) || [...(actor?.items ?? [])].some(item => transitionOf(item));
}

export function spellPointsItem(actor) {
  const items = actor?.items;
  const flagged = items?.get?.(actor.flags?.dnd5espellpoints?.item);
  if (flagged) return flagged;
  const resource = game.modules?.get("dnd5e-spellpoints")?.active
    ? game.settings.get("dnd5e-spellpoints", "settings")?.spResource ?? "Spell Points" : "Spell Points";
  return [...(items ?? [])].find(item => item.system?.identifier === "spell-points"
    || item.flags?.core?.sourceId?.startsWith("Compendium.dnd5e-spellpoints.module-items.")
    || (["feat", "class"].includes(item.type) && item.system?.source?.custom === resource));
}

export function spellPointsRemaining(item) {
  const uses = item?.system?.uses;
  const value = Number(uses?.value);
  if (uses?.value !== undefined && Number.isFinite(value)) return Math.max(0, value);
  return Math.max(0, (Number(uses?.max) || 0) - (Number(uses?.spent) || 0));
}

export async function bindSpellPoints(actor) {
  const item = spellPointsItem(actor);
  if (!item) throw new Error(`${actor.name}: не найдена особенность Spell Points.`);
  if (actor.flags?.dnd5espellpoints?.item !== item.id) {
    await actor.update({ "flags.dnd5espellpoints.item": item.id });
  }
  if (game.modules.get("dnd5e-spellpoints")?.active) {
    const label = game.settings.get("dnd5e-spellpoints", "settings")?.spResource ?? "Spell Points";
    if (item.system.source.custom !== label) await item.update({ "system.source.custom": label });
  }
  return item;
}

export function spellCost(activity, usage, message) {
  const item = spellPointsItem(activity.actor);
  const globalSettings = game.settings.get("dnd5e-spellpoints", "settings") ?? {};
  const config = item?.flags?.spellpoints?.override ? item.flags.spellpoints.config ?? {} : {};
  const costs = config.spellPointsCosts ?? globalSettings.spellPointsCosts ?? DEFAULT_COSTS;
  const level = Number(message?.data?.flags?.dnd5e?.use?.spellLevel
    ?? activity.actor.system.spells?.[usage.spell?.slot]?.level
    ?? ((Number(activity.item.system.level) || 0) + (Number(usage.scaling) || 0)));
  const formula = costs[level] ?? DEFAULT_COSTS[level];
  let cost = Number(formula);
  if (!Number.isFinite(cost)) {
    cost = new Roll(String(formula), activity.actor.getRollData()).evaluateSync({ strict: true }).total;
  }
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Некорректная стоимость заклинания в очках.");
  return cost;
}

export function consumeAuriandriaSpellPoints(activity, usage, message, updates) {
  if (!isAuriandria(activity.actor) || !activity.isSpell || !activity.consumption.spellSlot
    || !usage.consume?.spellPoints || usage.consume.spellSlot) return;
  const item = spellPointsItem(activity.actor);
  if (!item) {
    ui.notifications.error("Ауриандрия: не найден счётчик очков заклинаний.");
    return false;
  }
  try {
    const cost = spellCost(activity, usage, message);
    if (cost > spellPointsRemaining(item)) {
      ui.notifications.warn(`Недостаточно очков заклинаний: нужно ${cost}, осталось ${spellPointsRemaining(item)}.`);
      return false;
    }
    if (!cost) return;
    updates.item ??= [];
    let update = updates.item.find(entry => entry._id === item.id);
    if (!update) updates.item.push(update = { _id: item.id });
    update["system.uses.spent"] = (Number(item.system.uses.spent) || 0) + cost;
  } catch (error) {
    console.error(`${MODULE_ID} | Spell point consumption failed`, error);
    ui.notifications.error(error.message);
    return false;
  }
}

export async function registerAuriandriaSpellPoints() {
  if (!game.modules.get("dnd5e-spellpoints")?.active) {
    ui.notifications.warn("Ауриандрия: включите Advanced Magic — Spell Points System 5e для расхода очков заклинаний.");
    return;
  }
  const { SpellPoints } = await import("/modules/dnd5e-spellpoints/scripts/spellpoints.js");
  installSpellPointsAdapter(SpellPoints);
}

export function installSpellPointsAdapter(SpellPoints) {
  if (SpellPoints.apfceAuriandriaAdapter) return;
  SpellPoints.apfceAuriandriaAdapter = true;
  const original = SpellPoints.castSpell;
  // The installed module starts an async update from a synchronous hook. For these
  // forms, charge via dnd5e's awaited consumption update instead, exactly once.
  SpellPoints.castSpell = function(activity, ...args) {
    if (isAuriandria(activity?.actor)) return;
    return original.call(this, activity, ...args);
  };
  Hooks.on("dnd5e.activityConsumption", consumeAuriandriaSpellPoints);
}

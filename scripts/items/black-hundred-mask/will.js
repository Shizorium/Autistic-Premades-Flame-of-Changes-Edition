import { MODULE_ID } from "../../lib/identifier.js";
import { activeSymbols, automationTier, MASK_STATE, maskState } from "./data.js";

const pending = new Set();
export function currentTurn(actor) {
  // Use the actor's combat, even if another encounter is currently viewed.
  const combats = [...(game.combats ?? (game.combat ? [game.combat] : []))].filter(combat => combat.started
    && (combat.combatant?.actor?.uuid === actor.uuid || [...(combat.combatants ?? [])].some(entry => entry.actor?.uuid === actor.uuid)));
  const combat = combats.find(combat => combat === game.combat) ?? combats[0];
  if (!combat) return null;
  return { combat, key: `${combat.uuid ?? combat.id}:${combat.round}:${combat.turn}`, own: combat.combatant?.actor?.uuid === actor.uuid };
}
export function canHeal(actor) {
  const hp = actor.system?.attributes?.hp;
  const max = Number(hp?.effectiveMax ?? (Number(hp?.max) + (Number(hp?.tempmax) || 0)));
  return Number(hp?.value) > 0 && Number(hp.value) < max / 2;
}
export function hitDieChoices(actor, spend) {
  return [...(actor.itemTypes?.class ?? [])].filter(cls => Number(cls.system.levels) > 0
    && (!spend || Number(cls.system.hd?.value ?? (cls.system.levels - (cls.system.hd?.spent ?? 0))) > 0))
    .map(cls => ({ id: cls.id, name: cls.name, die: cls.system.hd?.denomination ?? cls.system.hitDice }))
    .filter(choice => /^d(?:4|6|8|10|12|20)$/.test(choice.die));
}
async function chooseDie(actor, spend) {
  const choices = hitDieChoices(actor, spend);
  if (!choices.length) throw new Error(spend ? "Нет доступных Костей Здоровья." : "У персонажа не определена Кость Здоровья класса.");
  if (choices.length === 1) return choices[0];
  const escape = foundry.utils.escapeHTML;
  const selected = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Символ Воли — Кость Здоровья" },
    content: `<label>Кость Здоровья <select name="hitDie">${choices.map(choice => `<option value="${choice.id}">${escape(choice.name)} (${choice.die})</option>`).join("")}</select></label>`,
    ok: { label: "Восстановить ПЗ", callback: (_event, button) => button.form.elements.hitDie.value }, rejectClose: false
  });
  return choices.find(choice => choice.id === selected);
}
function validateWill(actor) {
  if (!activeSymbols(actor).includes("will")) throw new Error("Символ Воли не активен на надетой маске.");
  if (automationTier(actor) < 6) throw new Error("На этом уровне Символ Воли восстанавливает ПЗ автоматически в начале хода.");
  if (!canHeal(actor)) throw new Error("Символ Воли работает только при ПЗ выше нуля и ниже половины максимума.");
  const turn = currentTurn(actor);
  if (turn && !turn.own) throw new Error("Символ Воли можно использовать только в свой ход.");
  if (turn && maskState(actor).willTurn === turn.key) throw new Error("Символ Воли уже использован в этом ходу.");
  return turn;
}

export async function useWill(actor) {
  if (!actor?.isOwner || pending.has(actor.uuid)) return;
  pending.add(actor.uuid);
  try {
    validateWill(actor);
    const spend = automationTier(actor) < 10;
    const choice = await chooseDie(actor, spend);
    if (!choice) return;
    // A die dialog can stay open while the turn or HP changes.
    const turn = validateWill(actor);
    if (!hitDieChoices(actor, spend).some(entry => entry.id === choice.id)) throw new Error("Выбранная Кость Здоровья больше недоступна.");
    const cls = actor.items.get(choice.id);
    const formula = `max(0, 1${choice.die} + @abilities.con.mod${spend ? "" : " + @abilities.int.mod"})`;
    const roll = await new Roll(formula, actor.getRollData()).evaluate();
    // Reserve this turn before updates; consuming only the chosen class's die supports multiclassing.
    const previousTurn = maskState(actor).willTurn ?? null;
    const previousSpent = Number(cls.system.hd?.spent) || 0;
    if (turn) await actor.update({ [`flags.${MODULE_ID}.${MASK_STATE}.willTurn`]: turn.key });
    try {
      if (spend) await cls.update({ "system.hd.spent": previousSpent + 1 });
      await actor.applyDamage([{ type: "healing", value: Number(roll.total) }]);
    } catch (error) {
      if (spend) await cls.update({ "system.hd.spent": previousSpent });
      if (turn) await actor.update({ [`flags.${MODULE_ID}.${MASK_STATE}.willTurn`]: previousTurn });
      throw error;
    }
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Символ Воли: восстановление ПЗ${spend ? " с расходом Кости Здоровья" : " без расхода Кости Здоровья"}.` });
    return roll;
  } finally { pending.delete(actor.uuid); }
}

export async function regenerateWill(combat) {
  const actor = combat.combatant?.actor;
  if (!combat.started || !actor?.isOwner || !activeSymbols(actor).includes("will") || automationTier(actor) >= 6 || !canHeal(actor)) return;
  const key = `${combat.uuid ?? combat.id}:${combat.round}:${combat.turn}`;
  if (maskState(actor).regenTurn === key || pending.has(actor.uuid)) return;
  pending.add(actor.uuid);
  try {
    const previous = maskState(actor).regenTurn ?? null;
    await actor.update({ [`flags.${MODULE_ID}.${MASK_STATE}.regenTurn`]: key });
    const before = Number(actor.system.attributes.hp.value);
    try { await actor.applyDamage([{ type: "healing", value: automationTier(actor) >= 3 ? 5 : 3 }]); }
    catch (error) {
      await actor.update({ [`flags.${MODULE_ID}.${MASK_STATE}.regenTurn`]: previous });
      throw error;
    }
    const healed = Number(actor.system.attributes.hp.value) - before;
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>Символ Воли восстанавливает ${healed} ПЗ.</p>` });
  } finally { pending.delete(actor.uuid); }
}

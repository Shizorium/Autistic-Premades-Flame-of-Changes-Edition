import { MODULE_ID, isItem } from "../../lib/identifier.js";

export const MASK_ID = "black-hundred-mask";
export const WILL_ID = "black-hundred-mask-will";
export const MASK_STATE = "blackHundredMask";
export const MASK_IMAGE = `modules/${MODULE_ID}/assets/black-hundred-mask.svg`;
export const SYMBOLS = {
  sword: { name: "Символ Меча", levels: {
    1: "+1 урона от атак оружием.",
    3: "+3 урона от атак оружием.",
    6: "+5 урона от атак оружием; все атаки считаются магическими; преимущество на атаку оружием один раз в ход (вручную).",
    10: "+7 урона от атак оружием; все атаки считаются магическими; преимущество на любую атаку один раз в ход (вручную).",
    14: "+9 урона от атак оружием; все атаки считаются магическими; преимущество на все атаки.",
    17: "+9 урона от атак оружием; все атаки считаются магическими; преимущество на все атаки; раз в ход можно провести одну атаку оружием по всем противникам в зоне досягаемости.",
    20: "?????"
  } },
  shield: { name: "Символ Щита", levels: {
    1: "+1 КД.", 3: "+2 КД.",
    6: "+3 КД; «Уклонение» бонусным действием (вручную).",
    10: "Модификатор Интеллекта добавляется к КД вместо фиксированного бонуса; «Уклонение» бонусным действием (вручную).",
    14: "Модификатор Интеллекта и +1 добавляются к КД; «Уклонение» всегда активно.",
    17: "Модификатор Интеллекта и +3 добавляются к КД; «Уклонение» всегда активно; при провале спасброска от заклинания — половина урона, при успехе — 0 урона.",
    20: "?????"
  } },
  will: { name: "Символ Воли", levels: {
    1: "Регенерация 3 ПЗ в начале своего хода, пока здоровье ниже половины; не работает при 0 ПЗ.",
    3: "Регенерация 5 ПЗ в начале своего хода, пока здоровье ниже половины; не работает при 0 ПЗ.",
    6: "Один раз в свой ход свободным действием потратьте Кость Здоровья и восстановите ПЗ в размере броска + модификатор Выносливости; только пока здоровье ниже половины; не работает при 0 ПЗ.",
    10: "Один раз в свой ход свободным действием бросьте Кость Здоровья без расходования и восстановите ПЗ в размере броска + модификатор Выносливости + модификатор Интеллекта; только пока здоровье ниже половины; не работает при 0 ПЗ.",
    14: "Один раз в свой ход свободным действием бросьте Кость Здоровья без расходования и восстановите ПЗ в размере броска + модификатор Выносливости + модификатор Интеллекта; только пока здоровье ниже половины; не работает при 0 ПЗ. Также один раз за ход можно восстановить половину максимальных ПЗ ценой уменьшения максимальных ПЗ вдвое; после этого нельзя получать временные максимальные или временные ПЗ; «Высшее восстановление» не возвращает потерянный максимум; не работает при 0 ПЗ.",
    17: "Один раз в свой ход свободным действием бросьте две Кости Здоровья без расходования и восстановите ПЗ в размере суммы бросков + удвоенный модификатор Выносливости + удвоенный модификатор Интеллекта; не работает при 0 ПЗ. Также один раз за ход можно восстановить половину максимальных ПЗ ценой уменьшения максимальных ПЗ на четверть; «Высшее восстановление» не возвращает потерянный максимум; не работает при 0 ПЗ.",
    20: "?????"
  } }
};

export const isMask = item => isItem(item, MASK_ID);
export const isWill = item => isItem(item, WILL_ID);
export const maskState = actor => actor?.flags?.[MODULE_ID]?.[MASK_STATE] ?? {};
export function characterLevel(actor) {
  const levels = [...(actor?.itemTypes?.class ?? [])].reduce((sum, cls) => sum + (Number(cls.system.levels) || 0), 0);
  return Math.max(1, levels || Number(actor?.system?.details?.level) || 1);
}
// No fourth slot is defined in the source rules; retain three above level 15.
export const symbolSlots = level => level >= 9 ? 3 : level >= 4 ? 2 : 1;
export const automationTier = actor => [10, 6, 3, 1].find(level => characterLevel(actor) >= level);
export function symbolDescription(symbol, level) {
  const rule = SYMBOLS[symbol];
  if (!rule) return "Без символа.";
  const tier = Object.keys(rule.levels).map(Number).sort((a, b) => b - a).find(value => level >= value) ?? 1;
  const text = rule.levels[tier];
  return level > 10 ? `${text} Автоматизация ограничена 10-м уровнем: ${rule.levels[10]}` : text;
}
export function selectedMask(actor) {
  const state = maskState(actor);
  const item = actor?.items?.get(state.itemId);
  return isMask(item) && item.system.equipped !== false ? item : null;
}
export function activeSymbols(actor) {
  if (!selectedMask(actor)) return [];
  const effect = [...(actor.effects ?? [])].find(effect => effect.flags?.[MODULE_ID]?.blackHundredMaskEffect
    && !effect.disabled && !effect.isSuppressed);
  return effect ? (maskState(actor).symbols ?? []).slice(0, symbolSlots(characterLevel(actor))) : [];
}
export function maskEffectData(actor, item, symbols) {
  const tier = automationTier(actor), changes = [];
  const add = (key, value) => changes.push({ key, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value, priority: 20 });
  if (symbols.includes("sword")) {
    const damage = String({ 1: 1, 3: 3, 6: 5, 10: 7 }[tier]);
    add("system.bonuses.mwak.damage", `${damage}[Символ Меча]`);
    add("system.bonuses.rwak.damage", `${damage}[Символ Меча]`);
  }
  if (symbols.includes("shield")) add("system.attributes.ac.bonus", tier === 10 ? "@abilities.int.mod" : String({ 1: 1, 3: 2, 6: 3 }[tier]));
  return {
    name: `Маска чёрной сотни: ${symbols.map(symbol => SYMBOLS[symbol].name.replace("Символ ", "")).join(", ")}`,
    img: item.img, origin: item.uuid, transfer: false, changes,
    flags: { [MODULE_ID]: { blackHundredMaskEffect: true, tier, symbols } }
  };
}
export function utilityActivity(id, name, condition) {
  return {
    _id: id, type: "utility", name,
    activation: { type: "special", value: 1, condition, override: false },
    consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
    target: { affects: { type: "self" }, template: {}, prompt: false, override: false },
    range: { units: "self", override: false },
    roll: { formula: "", prompt: false, visible: false }
  };
}
export function willFeatureData(actor) {
  const text = SYMBOLS.will.levels[automationTier(actor)];
  return {
    name: "Символ Воли — восстановление", type: "feat", img: MASK_IMAGE,
    system: {
      identifier: WILL_ID, type: { value: "enchantment" },
      description: { value: `<p>${text}</p>`, chat: "<p>Магия Символа Воли восстанавливает ПЗ носителя маски.</p>" },
      activities: { apfceMaskWill001: utilityActivity("apfceMaskWill001", "Восстановить ПЗ", "Свободное действие в свой ход, один раз в ход; 0 < ПЗ < половины максимума") }
    }, flags: { [MODULE_ID]: { identifier: WILL_ID, maskWillFeature: true } }
  };
}

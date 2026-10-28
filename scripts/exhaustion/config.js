import { MODULE_ID } from "../lib/identifier.js";

export const EXHAUSTION_PATH = "system.attributes.exhaustion";
export const EXHAUSTION_ICON = "systems/dnd5e/icons/svg/statuses/exhaustion.svg";
export const SYNC_OPTION = "apfceExhaustionSync";
export const ROLL_KEY = "apfceExhaustion";
export const ROLL_PART = `@${ROLL_KEY}[Истощение]`;

// Hooks may receive either expanded document data or dotted update keys.
export function updateValue(data, path) {
  return Object.prototype.hasOwnProperty.call(data, path) ? data[path] : foundry.utils.getProperty(data, path);
}

export function setUpdateValue(data, path, value) {
  if (Object.prototype.hasOwnProperty.call(data, path)) data[path] = value;
  else foundry.utils.setProperty(data, path, value);
}

export function registerExhaustionSettings(onChange) {
  game.settings.register(MODULE_ID, "exhaustionMaxLevel", {
    name: "Истощение: максимум уровней",
    hint: "Максимальный уровень истощения (1–100). По умолчанию — 10. Уровень даёт только штраф к d20, включая максимальный.",
    scope: "world", config: true, type: Number, default: 10,
    range: { min: 1, max: 100, step: 1 }, onChange
  });
  game.settings.register(MODULE_ID, "exhaustionPenaltyPerLevel", {
    name: "Истощение: штраф за каждый уровень",
    hint: "Положительное число, которое вычитается за каждый уровень из всех бросков d20 персонажа. Например: 1 даёт −5 на пятом уровне. Урон и Сл спасбросков не изменяются.",
    scope: "world", config: true, default: 1,
    type: new foundry.data.fields.NumberField({ required: true, nullable: false, min: 0, initial: 1 }),
    onChange
  });
  game.settings.register(MODULE_ID, "exhaustionPenaltyTable", {
    name: "Истощение: отдельные штрафы по уровням",
    hint: "Необязательно: итоговые штрафы для уровней 1, 2, 3… через пробел или точку с запятой, например: 1; 2; 4; 6; 8. Это итоговые значения, а не прибавки. Пустое поле использует штраф за уровень; для неуказанных уровней также используется обычное умножение.",
    scope: "world", config: true, default: "",
    type: new foundry.data.fields.StringField({
      initial: "", validate: value => !value.trim() || parsePenaltyTable(value) !== null,
      validationError: "Введите неотрицательные числа через пробел, запятую или точку с запятой. Для дробей используйте точку."
    }), onChange
  });
}

export function parsePenaltyTable(value) {
  if (!String(value ?? "").trim()) return [];
  const values = String(value).trim().split(/[\s,;]+/).map(Number);
  return values.every(n => Number.isFinite(n) && n >= 0) ? values : null;
}

export function exhaustionConfig() {
  const max = Number(game.settings.get(MODULE_ID, "exhaustionMaxLevel"));
  const perLevel = Number(game.settings.get(MODULE_ID, "exhaustionPenaltyPerLevel"));
  return {
    maxLevel: Math.min(100, Math.max(1, Math.trunc(max) || 10)),
    perLevel: Number.isFinite(perLevel) && perLevel >= 0 ? perLevel : 1,
    penalties: parsePenaltyTable(game.settings.get(MODULE_ID, "exhaustionPenaltyTable")) ?? []
  };
}

export function clampExhaustion(level, config = exhaustionConfig()) {
  const value = Number(level);
  return Number.isFinite(value) ? Math.min(config.maxLevel, Math.max(0, Math.trunc(value))) : 0;
}

export function exhaustionPenalty(level, config = exhaustionConfig()) {
  level = clampExhaustion(level, config);
  return level ? config.penalties[level - 1] ?? Number((level * config.perLevel).toFixed(6)) : 0;
}

export function exhaustionDescription(level, config = exhaustionConfig()) {
  const penalty = exhaustionPenalty(level, config);
  return `<p><strong>Истощение ${level}/${config.maxLevel}.</strong> Штраф −${penalty} ко всем броскам d20: атакам, спасброскам (включая концентрацию и спасброски от смерти), проверкам характеристик, навыков, инструментов и инициативе.</p><p>Урон, Сл спасбросков, скорость и максимум хитов не изменяются. Максимальный уровень сам по себе не накладывает смерть. Новый уровень заменяет предыдущий; уровень 0 снимает эффект.</p>`;
}

export function exhaustionEffectData(level, { id, config = exhaustionConfig() } = {}) {
  return {
    ...(id ? { _id: id } : {}),
    name: `Истощение ${level} (−${exhaustionPenalty(level, config)} к d20)`,
    img: EXHAUSTION_ICON, description: exhaustionDescription(level, config),
    disabled: false, transfer: false, statuses: ["exhaustion"], changes: [],
    flags: {
      dnd5e: { exhaustionLevel: level },
      [MODULE_ID]: { exhaustion: true, exhaustionLevel: level }
    }
  };
}

export function effectExhaustionLevel(effect) {
  const own = effect?.flags?.[MODULE_ID];
  const level = own?.exhaustionLevel ?? effect?.flags?.dnd5e?.exhaustionLevel;
  return Number.isFinite(level) ? level : 1;
}

export function isExhaustionEffect(effect) {
  return Boolean(effect?.flags?.[MODULE_ID]?.exhaustion)
    || Number.isFinite(effect?.flags?.dnd5e?.exhaustionLevel)
    || effect?.statuses?.has?.("exhaustion")
    || effect?.statuses?.includes?.("exhaustion");
}

export function isExhaustionPreset(item) {
  return item?.flags?.[MODULE_ID]?.exhaustionPreset === true;
}

import { MODULE_ID } from "../lib/identifier.js";

export const AURIANDRIA_FOLDER_ID = "apfceAuriFolder1";
export const AURIANDRIA_ACTOR_PACK = "apfce-auriandria-forms";
export const FORM_IDS = { sun: "apfceAuriSun0001", moon: "apfceAuriMoon001" };
export const FEATURE_IDS = { rules: "apfceAuriRules01", sun: "apfceAuriSunFeat", moon: "apfceAuriMoonFet" };
export const FORM_GROUP = "auriandria";
export const FORM_NAMES = { sun: "Солнце", moon: "Луна" };
export const FORM_ICONS = {
  sun: "icons/magic/light/explosion-star-glow-orange.webp",
  moon: "icons/magic/light/projectile-stars-blue.webp"
};

export function formOf(actor) { return actor?.flags?.[MODULE_ID]?.auriandriaForm; }
export function transitionOf(item) { return item?.flags?.[MODULE_ID]?.auriandriaTransition; }
export function opposite(form) { return form === "sun" ? "moon" : "sun"; }

export const DESCRIPTIONS = {
  rules: `<p>Ауриандрия может преобразиться из Солнца в Луну и обратно.</p>
<p>Преображение накладывает две единицы истощения и уменьшает максимум ПЗ на 5. Если преображение происходит во время суток, соответствующее Светилу, оно не накладывает штрафов.</p>
<p>Ауриандрия может получить право на преображение без штрафов, если с предыдущего преображения произошло что-то, что могло повлиять на её внутреннее состояние:</p>
<ul><li><strong>Луна:</strong> убийства, ярость, злость, мстительность, тяга к разрушению, обида, печаль.</li>
<li><strong>Солнце:</strong> добро, желание помочь, дружелюбие, радость, счастье, любовь.</li></ul>
<p>(Yes, you can bully your way to the Moon)</p>`,
  moon: `<p>Когда Ауриандрия преображается в Луну, все союзники на поле боя восстанавливают количество очков заклинаний, равное <strong>4 × уровень жреца</strong>; начиная с 11-го уровня жреца — <strong>5 × уровень жреца</strong>. Также они восстанавливают все использования способностей, восстанавливаемых за короткий отдых, или половину использований способностей, восстанавливаемых за длительный отдых (округление вверх).</p>
<p>Все противники в 15 футах от Ауриандрии должны пройти спасбросок Мудрости по её Сл заклинаний, иначе получают состояние <strong>Испуганный</strong> до конца следующего хода Ауриандрии.</p>
<p>Сразу после преображения Ауриандрия может использовать заклинание из своего списка заклинаний жреца, не тратя очки заклинаний.</p>`,
  sun: `<p>Когда Ауриандрия преображается в Солнце, все союзники на поле боя восстанавливают ПЗ, равные <strong>5 × уровень жреца</strong>, а также снимают любые эффекты, наносящие периодический урон (например, Кровотечение).</p>
<p>Все противники в 15 футах от Ауриандрии должны пройти спасбросок Ловкости по её Сл заклинаний. При провале они получают урон излучением, равный урону заговора <strong>Священное пламя</strong>, и состояние <strong>Ослеплённый</strong> до конца следующего хода Ауриандрии. Урон составляет 1к8 и увеличивается до 2к8 на 5-м, 3к8 на 11-м и 4к8 на 17-м уровне персонажа. При успехе урон и ослепление не применяются.</p>
<p>Сразу после преображения Ауриандрия может использовать заклинание из своего списка заклинаний жреца, не тратя очки заклинаний.</p>`
};

export function featureData(kind) {
  const rules = kind === "rules";
  const activityId = "apfceAuriShift01";
  return {
    _id: FEATURE_IDS[kind], name: rules ? "Солнце и луна" : FORM_NAMES[kind], type: "feat",
    img: FORM_ICONS[rules ? "sun" : kind], folder: AURIANDRIA_FOLDER_ID,
    system: {
      description: { value: DESCRIPTIONS[kind], chat: "" },
      identifier: `auriandria-${kind}`, source: { custom: "Flame of Changes — Ауриандрия", rules: "2014" },
      type: { value: "", subtype: "" }, uses: { max: "", spent: 0, recovery: [] },
      activities: rules ? {} : { [activityId]: {
        _id: activityId, name: `Преобразиться: ${FORM_NAMES[kind]}`, type: "utility",
        activation: { type: "special", value: 1, override: false, condition: "" },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false, max: "" } },
        duration: { units: "inst", concentration: false, override: false }, effects: [],
        range: { units: "self", override: false },
        target: { affects: { type: "self", choice: false }, template: { type: "", units: "ft" }, prompt: false },
        roll: { formula: "", prompt: false, visible: false }, uses: { spent: 0, max: "", recovery: [] }
      } }
    },
    effects: [], flags: { [MODULE_ID]: {
      identifier: `auriandria-${kind}`, ...(rules ? { auriandriaRules: true } : { auriandriaTransition: kind })
    } }
  };
}

export function clericLevel(actor) {
  const classes = actor?.itemTypes?.class ?? [...(actor?.items ?? [])].filter(item => item.type === "class");
  return classes.filter(item => item.system?.identifier === "cleric" || /^(жрец|cleric)$/i.test(item.name))
    .reduce((total, item) => total + (Number(item.system?.levels) || 0), 0);
}

export function sacredFlameDice(level) {
  return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
}

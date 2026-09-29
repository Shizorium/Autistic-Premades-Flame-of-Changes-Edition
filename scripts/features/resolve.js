import { MODULE_ID, RESOLVE_ID, isItem } from "../lib/identifier.js";

const handledUses = new Set();
const endingActors = new Set();
let registered = false;

export function registerResolve() {
  if (registered) return;
  registered = true;
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("dnd5e.preApplyDamage", onPreApplyDamage);
  Hooks.on("deleteActiveEffect", onDeleteEffect);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createActiveEffect", onCreateEffect);
}

function onPostUseActivity(activity) {
  const item = activity?.item;
  if (!isItem(item, RESOLVE_ID)) return;
  const actor = item.actor;
  if (!actor?.isOwner) return;
  const key = `${item.uuid}:${item.system?.uses?.spent ?? 0}`;
  if (!markHandled(key)) return;
  void applyResolve(actor, item);
}

async function applyResolve(actor, item) {
  const bonus = Math.max(0, 5 * resolveLevel(actor));
  const existing = findResolveEffect(actor);
  if (existing) {
    await existing.update({ duration: minuteDuration() });
    return;
  }

  const changes = bonus > 0 ? [{
    key: "system.attributes.hp.tempmax",
    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
    value: String(bonus),
    priority: 20
  }] : [];

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: "Решимый",
    img: item.img,
    origin: item.uuid,
    transfer: false,
    disabled: false,
    duration: minuteDuration(),
    changes,
    flags: {
      [MODULE_ID]: { resolve: true, bonus }
    }
  }]);

  if (bonus > 0) {
    const current = storedHp(actor);
    await actor.update({ "system.attributes.hp.value": current + bonus });
  }
}

function onDeleteEffect(effect, _options, userId) {
  if (game.user.id !== userId) return;
  if (!effect.flags?.[MODULE_ID]?.resolve) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  const bonus = Number(effect.flags[MODULE_ID].bonus) || 0;
  if (bonus <= 0) return;
  const next = Math.max(0, storedHp(actor) - bonus);
  if (next === storedHp(actor)) return;
  void actor.update({ "system.attributes.hp.value": next });
}

function onUpdateActor(actor, changes, _options, userId) {
  if (game.user.id !== userId) return;
  if (foundry.utils.getProperty(changes, "system.attributes.hp.value") !== 0) return;
  void endResolve(actor);
}

function onCreateEffect(effect, _options, userId) {
  if (game.user.id !== userId) return;
  if (!isUnconsciousEffect(effect)) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  void endResolve(actor);
}

function onPreApplyDamage(actor, amount, updates, options) {
  if (!updates || !isAttackHit(options)) return;
  const source = sourceActor(options);
  if (!isResolved(source)) return;

  const hp = actor.system?.attributes?.hp;
  if (!hp) return;
  const currentTemp = Number(hp.temp) || 0;
  const currentValue = Number(hp.value) || 0;
  const proposedTemp = Number(updates["system.attributes.hp.temp"]);
  const proposedValue = Number(updates["system.attributes.hp.value"]);
  const tempDropped = Number.isFinite(proposedTemp) && proposedTemp < currentTemp;
  const hpDropped = Number.isFinite(proposedValue) && proposedValue < currentValue;
  const hpNotIncreased = !Number.isFinite(proposedValue) || proposedValue <= currentValue;

  let damage = 0;
  if (amount > 0 && hpNotIncreased) damage = amount;
  else if (tempDropped || hpDropped) {
    const tempLoss = Math.max(0, currentTemp - (Number.isFinite(proposedTemp) ? proposedTemp : currentTemp));
    const hpLoss = Math.max(0, currentValue - (Number.isFinite(proposedValue) ? proposedValue : currentValue));
    damage = tempLoss + hpLoss;
  }
  if (!(damage > 0)) return;

  const keptTemp = Number.isFinite(proposedTemp) ? Math.max(currentTemp, proposedTemp) : currentTemp;
  updates["system.attributes.hp.temp"] = keptTemp;
  updates["system.attributes.hp.value"] = Math.max(0, currentValue - damage);
}

async function endResolve(actor) {
  if (!actor || endingActors.has(actor.uuid)) return;
  const effect = findResolveEffect(actor);
  if (!effect) return;
  endingActors.add(actor.uuid);
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
  } finally {
    setTimeout(() => endingActors.delete(actor.uuid), 500);
  }
}

function findResolveEffect(actor) {
  const effects = actor?.appliedEffects ?? actor?.effects ?? [];
  return [...effects].find((effect) => !effect.disabled && effect.flags?.[MODULE_ID]?.resolve) ?? null;
}

function isResolved(actor) {
  return Boolean(findResolveEffect(actor));
}

function resolveLevel(actor) {
  const classLevel = mageHunterLevel(actor);
  if (classLevel !== null) return classLevel;
  return Number(actor?.system?.details?.level) || 0;
}

function mageHunterLevel(actor) {
  const classes = actor?.itemTypes?.class ?? [];
  for (const cls of classes) {
    const id = cls.system?.identifier || cls.identifier || "";
    const name = cls.name || "";
    if (id === "mage-hunter" || /^mage hunter$/i.test(name) || name === "Охотник на магов") {
      return Number(cls.system?.levels) || 0;
    }
  }
  return null;
}

function sourceActor(options) {
  const uuid = options?.midi?.sourceActorUuid;
  if (uuid) {
    const actor = asActor(fromUuidSync(uuid));
    if (actor) return actor;
  }
  const message = options?.originatingMessage;
  if (!message) return null;
  const origin = typeof message.getOriginatingMessage === "function"
    ? message.getOriginatingMessage()
    : message;
  if (typeof origin?.getAssociatedActor === "function") {
    const actor = origin.getAssociatedActor();
    if (actor) return actor;
  }
  const actorId = origin?.speaker?.actor ?? message.speaker?.actor;
  return actorId ? game.actors.get(actorId) : null;
}

function asActor(doc) {
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  return doc.actor ?? null;
}

function isAttackHit(options) {
  if (options?.midi) return options.midi.isHit === true;
  const message = options?.originatingMessage;
  if (!message) return false;
  if (activityType(message) === "attack") return true;
  const origin = typeof message.getOriginatingMessage === "function"
    ? message.getOriginatingMessage()
    : null;
  return origin ? activityType(origin) === "attack" : false;
}

function activityType(message) {
  return message.getFlag?.("dnd5e", "activity")?.type
    ?? message.flags?.dnd5e?.activity?.type
    ?? "";
}

function isUnconsciousEffect(effect) {
  const statuses = effect.statuses;
  if (statuses?.has?.("unconscious")) return true;
  if (Array.isArray(statuses) && statuses.includes("unconscious")) return true;
  return effect.flags?.core?.statusId === "unconscious";
}

function storedHp(actor) {
  const source = actor._source?.system?.attributes?.hp?.value;
  const sourceValue = Number(source);
  if (Number.isFinite(sourceValue)) return sourceValue;
  return Number(actor.system?.attributes?.hp?.value) || 0;
}

function minuteDuration() {
  return {
    seconds: 60,
    rounds: 10,
    startTime: game.time?.worldTime ?? 0,
    startRound: game.combat?.round ?? 0,
    startTurn: game.combat?.turn ?? 0
  };
}

function markHandled(key) {
  if (handledUses.has(key)) return false;
  handledUses.add(key);
  setTimeout(() => handledUses.delete(key), 2000);
  return true;
}

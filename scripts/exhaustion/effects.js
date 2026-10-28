import { MODULE_ID } from "../lib/identifier.js";
import {
  clampExhaustion, effectExhaustionLevel, exhaustionEffectData, EXHAUSTION_PATH,
  isExhaustionEffect, isExhaustionPreset, setUpdateValue, SYNC_OPTION, updateValue
} from "./config.js";

const pending = new Map();

export function exhaustionEffectId() {
  return CONFIG.ActiveEffect.documentClass.ID.EXHAUSTION;
}

function supportsExhaustion(actor) {
  return actor?.documentName === "Actor" && ["character", "npc"].includes(actor.type);
}

function localChange(options, userId) {
  return !options[SYNC_OPTION] && userId === game.user.id;
}

export function setExhaustion(actor, level) {
  if (!supportsExhaustion(actor) || !actor.isOwner) return Promise.resolve();
  const key = actor.uuid;
  const previous = pending.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => synchronize(actor, clampExhaustion(level)));
  pending.set(key, task);
  // Attach the error handler even when Foundry does not await a document hook.
  void task.catch(error => {
    console.error(`${MODULE_ID} | Exhaustion synchronization failed for ${actor.uuid}`, error);
    ui.notifications?.error("Flame of Changes: не удалось обновить истощение. Подробности в консоли (F12).");
  }).finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  return task;
}

async function synchronize(actor, level) {
  const options = { [SYNC_OPTION]: true };
  const id = exhaustionEffectId();
  // Set source data first. dnd5e's descendant-create handler otherwise resets a new
  // exhaustion condition to level 1, even when its effect already specifies level 5.
  if (actor._source.system.attributes.exhaustion !== level) {
    await actor.update({ [EXHAUSTION_PATH]: level }, options);
  }
  const effects = [...actor.effects].filter(e => e.id === id || isExhaustionEffect(e));
  const remove = effects.filter(e => !level || e.id !== id).map(e => e.id);
  if (remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect", remove, options);
  if (level) {
    const data = exhaustionEffectData(level, { id });
    const current = actor.effects.get(id);
    if (current) {
      const source = current.toObject();
      const changed = Object.entries(data).some(([key, value]) => {
        if (key === "flags") return Object.entries(value).some(([scope, flags]) =>
          Object.entries(flags).some(([flag, flagValue]) => source.flags?.[scope]?.[flag] !== flagValue));
        return JSON.stringify(source[key]) !== JSON.stringify(value);
      });
      if (changed) await actor.updateEmbeddedDocuments("ActiveEffect", [data], options);
    } else await actor.createEmbeddedDocuments("ActiveEffect", [data], { ...options, keepId: true });
  }
}

export function registerExhaustionEffects() {
  const ActorClass = CONFIG.Actor.documentClass;
  const EffectClass = CONFIG.ActiveEffect.documentClass;

  // Replace the system's async synchronizer so sheet edits and effect edits share one queue.
  ActorClass.prototype._onUpdateExhaustion = function(data, options) {
    if (options[SYNC_OPTION]) return;
    const level = updateValue(data, EXHAUSTION_PATH);
    if (level !== undefined) return setExhaustion(this, level);
  };

  // The system derives the visible level from this fixed-ID effect. Do not add death at the cap.
  EffectClass.prototype._prepareExhaustionLevel = function() {
    const level = this.disabled ? 0 : clampExhaustion(this.getFlag("dnd5e", "exhaustionLevel") ?? 1);
    const data = exhaustionEffectData(level);
    this.name = data.name;
    this.img = data.img;
    this.description = data.description;
  };

  Hooks.on("preUpdateActor", (actor, changes) => {
    if (!supportsExhaustion(actor)) return;
    const level = updateValue(changes, EXHAUSTION_PATH);
    if (level !== undefined) setUpdateValue(changes, EXHAUSTION_PATH, clampExhaustion(level));
  });

  Hooks.on("preCreateItem", (item, _data, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(item.parent) || !isExhaustionPreset(item)) return;
    void setExhaustion(item.parent, item.flags[MODULE_ID].exhaustionLevel);
    return false;
  });

  Hooks.on("preCreateActiveEffect", (effect, _data, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(effect.parent) || !isExhaustionEffect(effect)) return;
    // Dropped effects usually acquire a random ID; convert them into the system's single condition.
    if (effect.id !== exhaustionEffectId()) {
      void setExhaustion(effect.parent, effectExhaustionLevel(effect));
      return false;
    }
    effect.updateSource(exhaustionEffectData(clampExhaustion(effectExhaustionLevel(effect))));
  });

  Hooks.on("preUpdateActiveEffect", (effect, changes, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(effect.parent) || !isExhaustionEffect(effect)) return;
    const level = updateValue(changes, "flags.dnd5e.exhaustionLevel")
      ?? updateValue(changes, `flags.${MODULE_ID}.exhaustionLevel`);
    if (level !== undefined) {
      const data = exhaustionEffectData(clampExhaustion(level));
      if (changes.disabled === true) data.disabled = true;
      setUpdateValue(changes, "flags.dnd5e.exhaustionLevel", clampExhaustion(level));
      setUpdateValue(changes, `flags.${MODULE_ID}.exhaustionLevel`, clampExhaustion(level));
      foundry.utils.mergeObject(changes, data);
    }
  });

  Hooks.on("createActiveEffect", (effect, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(effect.parent) || !isExhaustionEffect(effect)) return;
    void setExhaustion(effect.parent, effect.disabled ? 0 : effectExhaustionLevel(effect));
  });
  Hooks.on("updateActiveEffect", (effect, changes, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(effect.parent) || !isExhaustionEffect(effect)) return;
    const level = updateValue(changes, "flags.dnd5e.exhaustionLevel")
      ?? updateValue(changes, `flags.${MODULE_ID}.exhaustionLevel`)
      ?? effectExhaustionLevel(effect);
    void setExhaustion(effect.parent, effect.disabled ? 0 : level);
  });
  Hooks.on("deleteActiveEffect", (effect, options, userId) => {
    if (!localChange(options, userId) || !supportsExhaustion(effect.parent) || !isExhaustionEffect(effect)) return;
    const remaining = [...effect.parent.effects].find(e => !e.disabled && isExhaustionEffect(e));
    void setExhaustion(effect.parent, remaining ? effectExhaustionLevel(remaining) : 0);
  });
}

export async function reconcileExhaustionActors() {
  if (game.users.activeGM?.id !== game.user.id) return;
  const actors = new Map([...game.actors].map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (!token.actorLink && token.actor) actors.set(token.actor.uuid, token.actor);
    }
  }
  for (const actor of actors.values()) {
    if (!supportsExhaustion(actor)) continue;
    const effect = actor.effects.get(exhaustionEffectId())
      ?? [...actor.effects].find(e => !e.disabled && isExhaustionEffect(e));
    const level = effect ? (effect.disabled ? 0 : effectExhaustionLevel(effect))
      : actor._source.system.attributes.exhaustion;
    if (effect || level) await setExhaustion(actor, level);
  }
}

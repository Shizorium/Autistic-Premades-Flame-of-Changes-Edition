import { MODULE_ID } from "../lib/identifier.js";
import { isExhaustionEffect } from "../exhaustion/config.js";
import { setExhaustion } from "../exhaustion/effects.js";

const MOVING = "auriandriaMoving";
const REINDEX = "apfceAuriandriaReindex";
const RUNTIME_ITEM = "auriandriaRuntimeItem";
const SCOPES = ["dnd5e", "midi-qol", "dae"];
export const TRANSFER_OPTIONS = Object.freeze({
  apfceAuriandriaTransfer: true, noConcentrationCheck: true, isUndo: true, undo: true, animate: false,
  // Moving the existing HP state is not a new damage/healing event for Midi-QOL.
  midiVitalityUpdatePending: true
});
const QUIET = Object.freeze({ ...TRANSFER_OPTIONS, noHook: true });
const protectedMethods = new WeakMap();

const values = collection => [...(collection ?? [])];
const ownFlags = document => document.flags?.[MODULE_ID] ?? {};
const clone = data => foundry.utils.deepClone(data);
const dataOf = document => document.toObject();
const registries = () => [game.dnd5e?.registry?.dependents, globalThis.MidiQOL?.MidiDependentsRegistry].filter(Boolean);

function get(data, path) { return foundry.utils.getProperty(data, path); }

/** Rewrite UUIDs in a single pass: a Moon -> Sun replacement must not be replaced again. */
export function rewriteReferences(data, references) {
  const keys = [...references.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return clone(data);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(?:${keys.map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
  function rewrite(value) {
    if (typeof value === "string") return value.replace(expression, match => references.get(match));
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const updated = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, rewrite(v)]));
      if (typeof value.uuid === "string" && typeof value.id === "string" && value.uuid.endsWith(`.${value.id}`)) {
        updated.id = updated.uuid.split(".").at(-1);
      }
      return updated;
    }
    return value;
  }
  return rewrite(data);
}

function sameItem(first, second) {
  return first.type === second.type && ((first.system?.identifier && first.system.identifier === second.system?.identifier)
    || first.name === second.name);
}

function itemInForm(item, target) {
  const sameId = target.items.get(item.id);
  if (sameId && sameItem(item, sameId) && !ownFlags(sameId)[RUNTIME_ITEM]) return sameId;
  const matches = values(target.items).filter(other => !ownFlags(other)[RUNTIME_ITEM] && sameItem(item, other));
  return matches.length === 1 ? matches[0] : null;
}

function activityInItem(activity, item) {
  const exact = item.system?.activities?.get?.(activity.id);
  if (exact) return exact;
  const matches = values(item.system?.activities).filter(other => other.type === activity.type && other.name === activity.name);
  return matches.length === 1 ? matches[0] : null;
}

function isConcentration(effect) {
  return effect.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating")
    || effect.statuses?.includes?.("concentrating");
}

function temporaryItemEffect(effect, item) {
  const duration = effect.duration;
  const started = duration?.startTime != null || duration?.startRound != null;
  return ownFlags(effect).auriandriaSharedEffect || effect.flags?.dnd5e?.dependentOn
    || (effect.type === "enchantment" && effect.origin && effect.origin !== item.uuid)
    // Spell templates also have durations, but their timers have never started.
    || (started && (Number(duration.seconds) > 0 || Number(duration.rounds) > 0 || Number(duration.turns) > 0));
}

/** Repair spell templates moved by older versions, using the recorded original effect UUID. */
export async function restoreAuriandriaEffectTemplates() {
  if (game.users.activeGM?.id !== game.user.id) return 0;
  let restored = 0;
  for (const actor of game.actors) {
    if (!["sun", "moon"].includes(ownFlags(actor).auriandriaForm)) continue;
    for (const item of actor.items) for (const effect of values(item.effects)) {
      const flags = ownFlags(effect), duration = effect.duration;
      if (!flags.auriandriaSharedEffect || effect.flags?.dnd5e?.dependentOn || effect.type === "enchantment"
        || duration?.startTime != null || duration?.startRound != null
        || !(Number(duration?.seconds) > 0 || Number(duration?.rounds) > 0 || Number(duration?.turns) > 0)) continue;
      const original = flags.auriandriaEffectKey?.match(/^(.+\.Item\.[^.]+)\.ActiveEffect\.([^.]+)$/);
      if (!original) continue;
      const owner = await fromUuid(original[1]);
      if (owner?.documentName !== "Item" || owner.actor?.pack
        || !["sun", "moon"].includes(ownFlags(owner.actor ?? {}).auriandriaForm)) continue;
      const existing = owner.effects.get(original[2]);
      // Preserve any independently edited original that already occupies this ID.
      if (existing && existing !== effect) continue;
      const clear = Object.fromEntries(["auriandriaSharedEffect", "auriandriaEffectKey", MOVING]
        .map(key => [`flags.${MODULE_ID}.-=${key}`, null]));
      if (existing === effect) await effect.update(clear, { ...QUIET });
      else {
        const references = new Map([[actor.uuid, owner.actor.uuid], [item.uuid, owner.uuid]]);
        const data = rewriteReferences(dataOf(effect), references);
        data._id = original[2];
        delete data.flags[MODULE_ID].auriandriaSharedEffect;
        delete data.flags[MODULE_ID].auriandriaEffectKey;
        data.flags[MODULE_ID][MOVING] = true;
        const [copy] = await owner.createEmbeddedDocuments("ActiveEffect", [data], { ...QUIET, keepId: true });
        await copy.update(clear, { ...QUIET });
        await effect.update({ [`flags.${MODULE_ID}.${MOVING}`]: true }, { ...QUIET });
        await item.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { ...QUIET });
      }
      restored++;
    }
  }
  return restored;
}

function effectData(effect, references, id) {
  const data = rewriteReferences(dataOf(effect), references);
  data._id = id;
  data.flags ??= {}; data.flags[MODULE_ID] ??= {};
  Object.assign(data.flags[MODULE_ID], {
    auriandriaSharedEffect: true, auriandriaEffectKey: ownFlags(effect).auriandriaEffectKey ?? effect.uuid,
    [MOVING]: true
  });
  const dependentOn = effect.flags?.dnd5e?.dependentOn;
  const localParent = typeof dependentOn === "string" ? effect.parent.effects?.get?.(dependentOn) : null;
  if (localParent && references.has(localParent.uuid)) {
    data.flags.dnd5e.dependentOn = references.get(localParent.uuid).split(".").at(-1);
  }
  return data;
}

function documentsInWorld(source, target) {
  const documents = new Map();
  const add = document => {
    if (!document?.uuid || documents.has(document.uuid)) return;
    documents.set(document.uuid, document);
    if (document.documentName === "Actor") {
      for (const item of values(document.items)) add(item);
    }
    // AmbientSound.effects contains audio filter settings, not ActiveEffect documents.
    if (["Actor", "Item"].includes(document.documentName)) {
      for (const effect of values(document.effects)) add(effect);
    }
  };
  for (const actor of game.actors) add(actor);
  add(source); add(target);
  for (const scene of game.scenes) {
    for (const token of values(scene.tokens)) { add(token); add(token.actor); }
    for (const key of ["templates", "regions", "lights", "drawings", "tiles", "sounds"]) {
      for (const document of values(scene[key])) add(document);
    }
  }
  return documents;
}

function reindex(document, oldParent, newParent) {
  for (const registry of registries()) {
    if (oldParent && oldParent !== newParent) registry.untrack(oldParent, document);
    if (newParent) registry.track(newParent, document);
  }
}

export function originalValues(document, changes) {
  const restore = {};
  const visit = (value, path) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
      return;
    }
    const actualPath = path.split(".").map(key => key.startsWith("-=") ? key.slice(2) : key).join(".");
    const old = get(document, actualPath);
    if (actualPath !== path) {
      if (old !== undefined) restore[actualPath] = clone(old);
      return;
    }
    if (old !== undefined) restore[path] = clone(old);
    else {
      const keys = path.split("."), key = keys.pop();
      restore[`${keys.join(".")}.-=${key}`] = null;
    }
  };
  for (const [key, value] of Object.entries(changes)) visit(value, key);
  return restore;
}

async function updateReferences(document, changes, options = {}, journal) {
  if (journal) {
    const restore = originalValues(document, changes);
    journal.push(async () => updateReferences(await fromUuid(document.uuid) ?? document, restore));
  }
  const oldParent = document.flags?.dnd5e?.dependentOn;
  const newParent = get(changes, "flags.dnd5e.dependentOn") ?? changes["flags.dnd5e.dependentOn"];
  await document.update(changes, {
    ...TRANSFER_OPTIONS, ...options, [REINDEX]: { oldParent: oldParent ?? null }
  });
  // The hook also does this on every other connected client.
  reindex(document, oldParent, newParent ?? document.flags?.dnd5e?.dependentOn);
}

async function detach(document, journal) {
  const changes = {};
  if (document.flags?.dnd5e?.dependentOn) changes["flags.dnd5e.dependentOn"] = null;
  if (document.flags?.dnd5e?.dependents?.length) changes["flags.dnd5e.dependents"] = [];
  if (Object.keys(changes).length) await updateReferences(document, changes, {}, journal);
}

async function createDocuments(parent, type, data, journal) {
  const collection = type === "Item" ? parent.items : parent.effects;
  const ids = data.map(entry => entry._id).filter(id => !collection.get(id));
  journal.push(async () => {
    const currentParent = await fromUuid(parent.uuid) ?? parent;
    const currentCollection = type === "Item" ? currentParent.items : currentParent.effects;
    const documents = ids.map(id => currentCollection.get(id)).filter(Boolean);
    for (const document of documents) {
      await document.update({ [`flags.${MODULE_ID}.${MOVING}`]: true }, { ...QUIET });
      for (const effect of values(document.effects)) await effect.update({ [`flags.${MODULE_ID}.${MOVING}`]: true }, { ...QUIET });
      await detach(document);
    }
    if (documents.length) await currentParent.deleteEmbeddedDocuments(type, documents.map(document => document.id), { ...QUIET });
  });
  return parent.createEmbeddedDocuments(type, data, { ...QUIET, keepId: true, keepEmbeddedIds: true });
}

async function removeDocuments(parent, type, documents, journal) {
  const snapshots = documents.map(dataOf);
  journal.push(async () => {
    const currentParent = await fromUuid(parent.uuid) ?? parent;
    const collection = type === "Item" ? currentParent.items : currentParent.effects;
    const missing = snapshots.filter(data => !collection.get(data._id));
    if (missing.length) {
      for (const data of missing) {
        data.flags ??= {}; data.flags[MODULE_ID] ??= {}; data.flags[MODULE_ID][MOVING] = true;
      }
      await currentParent.createEmbeddedDocuments(type, missing, { ...QUIET, keepId: true, keepEmbeddedIds: true });
      for (const data of missing) await collection.get(data._id).update({ [`flags.${MODULE_ID}.${MOVING}`]: false }, { ...QUIET });
    }
  });
  return parent.deleteEmbeddedDocuments(type, documents.map(document => document.id), { ...QUIET });
}

function referenceChanges(document, references) {
  const changes = {};
  if (document.origin) {
    const origin = rewriteReferences(document.origin, references);
    if (origin !== document.origin) changes.origin = origin;
  }
  for (const scope of SCOPES) {
    if (!document.flags?.[scope]) continue;
    const updated = rewriteReferences(document.flags[scope], references);
    if (JSON.stringify(updated) !== JSON.stringify(document.flags[scope])) changes[`flags.${scope}`] = updated;
  }
  return changes;
}

/** Move battle state, not just its visible icons. The inactive form retains no live concentration. */
export async function transferBattleState(source, target) {
  const journal = [];
  const restore = async () => {
    for (const undo of [...journal].reverse()) {
      try { await undo(); }
      catch (restoreError) { console.error(`${MODULE_ID} | Could not restore battle state`, restoreError); }
    }
  };
  try { await moveBattleState(source, target, journal); }
  catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

async function moveBattleState(source, target, journal) {
  const exhaustion = source.system.attributes.exhaustion ?? 0;
  const incoming = values(source.effects).filter(effect => !isExhaustionEffect(effect));
  const stale = values(target.effects).filter(effect => ownFlags(effect).auriandriaSharedEffect);
  const references = new Map([[source.uuid, target.uuid]]);
  const itemPlans = [], effectPlans = [], staleItemEffects = [];
  const itemDestinations = new Map();
  const sourceRuntimeItems = values(source.items).filter(item => ownFlags(item)[RUNTIME_ITEM] || item.flags?.dnd5e?.dependentOn);
  const staleRuntimeItems = values(target.items).filter(item => ownFlags(item)[RUNTIME_ITEM]);
  const staleOwnedEffects = staleRuntimeItems.flatMap(item => values(item.effects));
  const needed = new Set(sourceRuntimeItems.map(item => item.id));
  const concentrationForItem = new Map();

  for (const effect of incoming) {
    if (isConcentration(effect)) {
      const id = effect.flags?.dnd5e?.item?.id;
      if (id) { needed.add(id); concentrationForItem.set(id, effect); }
    }
    for (const item of source.items) if (effect.origin?.startsWith(`${item.uuid}.`) || effect.origin === item.uuid) needed.add(item.id);
  }
  for (const item of source.items) {
    const isTemporary = (ownFlags(item)[RUNTIME_ITEM] || item.flags?.dnd5e?.dependentOn) && !ownFlags(item).auriandriaCastAnchor;
    const destination = isTemporary ? null : itemInForm(item, target);
    const itemEffects = values(item.effects).filter(effect => temporaryItemEffect(effect, item));
    if (itemEffects.length) needed.add(item.id);
    if (destination) itemDestinations.set(item.id, destination);
    else if (needed.has(item.id) && !["class", "subclass", "race", "background"].includes(item.type)) {
      const collision = target.items.get(item.id);
      const id = collision && !ownFlags(collision)[RUNTIME_ITEM] ? foundry.utils.randomID() : item.id;
      const uuid = `${target.uuid}.Item.${id}`;
      itemPlans.push({ source: item, id, uuid, concentration: concentrationForItem.get(item.id) });
      itemDestinations.set(item.id, { id, uuid });
    }
    // Identity mappings protect form-specific items from the broader Actor UUID rewrite.
    references.set(item.uuid, itemDestinations.get(item.id)?.uuid ?? item.uuid);
    const destinationUUID = references.get(item.uuid);
    for (const activity of values(item.system?.activities)) {
      const corresponding = destination ? activityInItem(activity, destination) : null;
      if (activity.uuid) references.set(activity.uuid, `${destinationUUID}.Activity.${corresponding?.id ?? activity.id}`);
    }
    if (!destination) continue; // New runtime items carry their own effects below.
    for (const effect of itemEffects) {
      const existing = destination.effects?.get(effect.id);
      const id = existing && !ownFlags(existing).auriandriaSharedEffect ? foundry.utils.randomID() : effect.id;
      references.set(effect.uuid, `${destination.uuid}.ActiveEffect.${id}`);
      effectPlans.push({ source: effect, parent: destination, id });
    }
    staleItemEffects.push(...values(destination.effects).filter(effect => ownFlags(effect).auriandriaSharedEffect));
  }
  for (const effect of incoming) {
    const existing = target.effects.get(effect.id);
    const id = existing && !ownFlags(existing).auriandriaSharedEffect ? foundry.utils.randomID() : effect.id;
    references.set(effect.uuid, `${target.uuid}.ActiveEffect.${id}`);
    effectPlans.push({ source: effect, parent: target, id });
    const previous = stale.filter(old => ownFlags(old).auriandriaEffectKey
      ? ownFlags(old).auriandriaEffectKey === (ownFlags(effect).auriandriaEffectKey ?? effect.uuid)
      : old.name === effect.name && old.flags?.dnd5e?.item?.id === effect.flags?.dnd5e?.item?.id);
    if (previous.length === 1) references.set(previous[0].uuid, `${target.uuid}.ActiveEffect.${id}`);
  }
  // Child effects of copied runtime items also change UUID even though their IDs survive.
  for (const plan of itemPlans) for (const effect of values(plan.source.effects)) {
    references.set(effect.uuid, `${plan.uuid}.ActiveEffect.${effect.id}`);
  }

  const world = documentsInWorld(source, target);
  // Include off-scene dependents registered by the system or Midi-QOL.
  for (const effect of [...incoming, ...stale, ...effectPlans.map(plan => plan.source)]) {
    for (const document of effect.getDependents?.() ?? []) if (document?.uuid) world.set(document.uuid, document);
    for (const registry of registries()) for (const document of registry.get(effect) ?? []) {
      if (document?.uuid) world.set(document.uuid, document);
    }
  }
  const removed = new Set([...stale, ...staleItemEffects, ...staleRuntimeItems, ...staleOwnedEffects].map(document => document.uuid));

  // Detach stale copies before deletion. Deleting a concentration is otherwise destructive to its dependents.
  for (const document of [...stale, ...staleItemEffects, ...staleRuntimeItems, ...staleOwnedEffects]) await detach(document, journal);
  // Rewire external dependencies before deleting their former parents.
  for (const document of world.values()) {
    if (removed.has(document.uuid) || document === source || document === target
      || document.parent === source || document.parent === target) continue;
    const changes = referenceChanges(document, references);
    if (Object.keys(changes).length) await updateReferences(document, changes, {}, journal);
  }
  // No registry entry may still point at a stale effect that is about to be deleted.
  for (const old of [...stale, ...staleItemEffects]) for (const registry of registries()) {
    for (const dependent of registry.get(old) ?? []) registry.untrack(old.uuid, dependent);
  }
  if (stale.length) await removeDocuments(target, "ActiveEffect", stale, journal);
  for (const effect of staleItemEffects) await removeDocuments(effect.parent, "ActiveEffect", [effect], journal);
  if (staleRuntimeItems.length) await removeDocuments(target, "Item", staleRuntimeItems, journal);

  const actorEffects = effectPlans.filter(plan => plan.parent === target);
  if (actorEffects.length) await createDocuments(target, "ActiveEffect",
    actorEffects.map(plan => effectData(plan.source, references, plan.id)), journal);
  for (const plan of itemPlans) {
    const data = rewriteReferences(dataOf(plan.source), references);
    data._id = plan.id;
    data.flags ??= {}; data.flags[MODULE_ID] ??= {};
    Object.assign(data.flags[MODULE_ID], {
      [RUNTIME_ITEM]: true, [MOVING]: true,
      auriandriaCastAnchor: ownFlags(plan.source).auriandriaCastAnchor
        || (!plan.source.flags?.dnd5e?.dependentOn && Boolean(plan.concentration))
    });
    if (plan.concentration && !data.flags.dnd5e?.dependentOn) {
      data.flags.dnd5e ??= {}; data.flags.dnd5e.dependentOn = references.get(plan.concentration.uuid);
    }
    for (const effect of data.effects ?? []) {
      effect.flags ??= {}; effect.flags[MODULE_ID] ??= {}; effect.flags[MODULE_ID][MOVING] = true;
    }
    await createDocuments(target, "Item", [data], journal);
  }
  for (const plan of effectPlans.filter(plan => plan.parent !== target)) {
    await createDocuments(plan.parent, "ActiveEffect", [effectData(plan.source, references, plan.id)], journal);
  }
  // Concentration identifies the actual item in the new form, including different embedded IDs.
  for (const plan of actorEffects.filter(plan => isConcentration(plan.source))) {
    const effect = target.effects.get(plan.id);
    const oldItemId = plan.source.flags?.dnd5e?.item?.id;
    const item = itemDestinations.get(oldItemId);
    const sourceItem = source.items.get(oldItemId);
    const activityId = plan.source.flags?.dnd5e?.activity?.id;
    const sourceActivity = sourceItem?.system?.activities?.get?.(activityId);
    const mappedActivity = sourceActivity?.uuid ? references.get(sourceActivity.uuid) : null;
    if (item) await effect.update({
      "flags.dnd5e.item.id": item.id, "flags.dnd5e.item.uuid": item.uuid,
      ...(activityId ? { "flags.dnd5e.activity.uuid": mappedActivity ?? `${item.uuid}.Activity.${activityId}`,
        "flags.dnd5e.activity.id": mappedActivity?.split(".").at(-1) ?? activityId } : {})
    }, { ...QUIET });
    else if (sourceItem) await effect.update({ "flags.dnd5e.item.data": dataOf(sourceItem) }, { ...QUIET });
  }

  // Source-side records are removed after all graph edges point at the new copies.
  const outgoingItemEffects = effectPlans.filter(plan => plan.source.parent !== source).map(plan => plan.source);
  for (const document of [...incoming, ...outgoingItemEffects, ...sourceRuntimeItems, ...sourceRuntimeItems.flatMap(item => values(item.effects))]) {
    await detach(document, journal);
  }
  if (incoming.length) await removeDocuments(source, "ActiveEffect", incoming, journal);
  for (const effect of outgoingItemEffects) await removeDocuments(effect.parent, "ActiveEffect", [effect], journal);
  if (sourceRuntimeItems.length) await removeDocuments(source, "Item", sourceRuntimeItems, journal);
  const targetExhaustion = target.system.attributes.exhaustion ?? 0;
  journal.push(async () => { await setExhaustion(source, exhaustion); await setExhaustion(target, targetExhaustion); });
  await setExhaustion(target, exhaustion);
  await setExhaustion(source, 0);

  // Transfer runtime combat flags, while retaining each sheet's settings and base characteristics.
  const paths = ["flags.midi-qol.actions", "flags.midi-qol.concentration-data", "flags.midi-qol.concentration-damage",
    "flags.dae.onUpdateSource", "flags.dae.onUpdateTarget"];
  for (const path of paths) {
    const value = get(source, path);
    if (value !== undefined) {
      await updateReferences(target, { [path]: rewriteReferences(value, references) }, {}, journal);
      const keys = path.split("."), key = keys.pop();
      await updateReferences(source, { [`${keys.join(".")}.-=${key}`]: null }, {}, journal);
    }
    else if (get(target, path) !== undefined) {
      const keys = path.split("."), key = keys.pop();
      await updateReferences(target, { [`${keys.join(".")}.-=${key}`]: null }, {}, journal);
    }
  }
  for (const document of documentsInWorld(source, target).values()) {
    if (ownFlags(document)[MOVING]) await document.update({ [`flags.${MODULE_ID}.${MOVING}`]: false }, { ...QUIET });
  }
  // Existing concentration chat cards must keep resolving the currently active caster.
  const concentrationIds = new Map(actorEffects.filter(plan => isConcentration(plan.source)).map(plan => [plan.source.id, plan.id]));
  for (const message of values(game.messages)) {
    if (message.speaker?.actor !== source.id || !concentrationIds.has(message.system?.concentration)) continue;
    const changes = referenceChanges(message, references);
    changes["speaker.actor"] = target.id;
    changes["system.concentration"] = concentrationIds.get(message.system.concentration);
    await updateReferences(message, changes, {}, journal);
  }
}

function protectMovingDocument(type, method, wrapper) {
  const prototype = CONFIG[type].documentClass.prototype;
  if (typeof prototype[method] !== "function") return;
  let registered = protectedMethods.get(prototype);
  if (registered?.has(method)) return;
  if (globalThis.libWrapper?.register) {
    // These guards may stop the call only while our own documents are moving.
    // MIXED keeps existing WRAPPER handlers (Times Up, Autistic Premades) in the chain.
    globalThis.libWrapper.register(MODULE_ID, `CONFIG.${type}.documentClass.prototype.${method}`, wrapper, "MIXED");
  } else {
    const original = prototype[method];
    prototype[method] = function(...args) {
      return wrapper.call(this, original.bind(this), ...args);
    };
  }
  if (!registered) protectedMethods.set(prototype, registered = new Set());
  registered.add(method);
}

export function registerAuriandriaState() {
  for (const type of ["ActiveEffect", "Item", "Actor", "Token", "MeasuredTemplate", "Region", "AmbientLight", "Tile", "Drawing", "AmbientSound"]) {
    Hooks.on(`update${type}`, (document, _changes, options) => {
      if (options[REINDEX]) reindex(document, options[REINDEX].oldParent, document.flags?.dnd5e?.dependentOn);
    });
  }
  for (const method of ["createRiderConditions", "createRiderEnchantments", "getDependents"]) {
    protectMovingDocument("ActiveEffect", method, function(wrapped, ...args) {
      if (ownFlags(this)[MOVING]) return method === "getDependents" ? [] : Promise.resolve([]);
      return wrapped(...args);
    });
  }
  protectMovingDocument("Actor", "endConcentration", function(wrapped, target, ...args) {
    if (ownFlags(target ?? {})[MOVING]) return Promise.resolve([]);
    return wrapped(target, ...args);
  });
  Hooks.on("dnd5e.preUseActivity", activity => {
    if (!ownFlags(activity.item).auriandriaCastAnchor) return;
    ui.notifications.warn("Это заклинание поддерживается из прежней формы. Для нового сотворения вернитесь в форму, которой оно доступно.");
    return false;
  });
}

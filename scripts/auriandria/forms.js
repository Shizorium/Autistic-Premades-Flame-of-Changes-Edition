import { MODULE_ID } from "../lib/identifier.js";
import { FORM_GROUP, FORM_NAMES, featureData, formOf, opposite, transitionOf } from "./data.js";
import { bindSpellPoints, spellPointsItem, spellPointsRemaining } from "./spellpoints.js";
import { applyTransformationBurst } from "./battlefield.js";
import { originalValues, transferBattleState, TRANSFER_OPTIONS } from "./state.js";

const pendingForms = new Set();

async function updateWithRollback(document, changes, journal, options = {}) {
  const snapshot = originalValues(document.toObject?.() ?? document, changes);
  journal.push(async () => {
    const current = await fromUuid(document.uuid) ?? document;
    await current.update(snapshot, { ...TRANSFER_OPTIONS, ...options });
  });
  await document.update(changes, { ...TRANSFER_OPTIONS, ...options });
}

function transformedTokenData(target) {
  // Serialize the complete PrototypeToken; its texture and sight fields are plain objects.
  const prototype = target.prototypeToken.toObject();
  return {
    actorId: target.id, actorLink: true, delta: {}, name: prototype.name || target.name,
    texture: prototype.texture, width: prototype.width, height: prototype.height,
    sight: prototype.sight, detectionModes: prototype.detectionModes
  };
}

function effectiveHPMaximum(actor) {
  const hp = actor.system.attributes.hp;
  return Number(hp.effectiveMax ?? (Number(hp.max) + (Number(hp.tempmax) || 0)));
}

export function sharedResourceUpdates(source, target) {
  const hp = source.system.attributes.hp;
  const sourceHP = source._source.system.attributes.hp;
  const tempmax = Number(sourceHP.tempmax) || 0;
  const actor = {
    "system.attributes.hp.value": Math.max(0, Number(hp.value) || 0),
    "system.attributes.hp.temp": Math.max(0, Number(hp.temp) || 0),
    "system.attributes.hp.tempmax": tempmax,
    "system.attributes.death": foundry.utils.deepClone(source._source.system.attributes.death ?? { success: 0, failure: 0 }),
    "system.attributes.inspiration": Boolean(source.system.attributes.inspiration)
  };
  for (const [slot, data] of Object.entries(source._source.system.spells ?? {})) {
    if (target.system.spells?.[slot] && Number.isFinite(data.value)) actor[`system.spells.${slot}.value`] = data.value;
  }
  const points = spellPointsItem(source), targetPoints = spellPointsItem(target);
  if (!points || !targetPoints) throw new Error("В одной из форм не найдены очки заклинаний.");
  const item = [{
    _id: targetPoints.id,
    "system.uses.spent": Math.max(0, (Number(targetPoints.system.uses.max) || 0) - spellPointsRemaining(points))
  }];
  // Shared abilities keep their expenditure; switching form is not a rest.
  for (const destination of target.items) {
    if (destination.id === targetPoints.id || transitionOf(destination)) continue;
    const original = source.items.get(destination.id)
      ?? [...source.items].find(entry => entry.type === destination.type
        && entry.system.identifier && entry.system.identifier === destination.system.identifier);
    if (!original?.system.uses || !destination.system.uses) continue;
    const update = { _id: destination.id, "system.uses.spent": Number(original.system.uses.spent) || 0 };
    for (const activity of destination.system.activities ?? []) {
      const previous = original.system.activities?.get?.(activity.id);
      if (previous?.uses) update[`system.activities.${activity.id}.uses.spent`] = previous.uses.spent;
    }
    item.push(update);
  }
  return { actor, item };
}

async function ensureFormButtons(actor, form) {
  const add = [];
  if (![...actor.items].some(item => item.flags?.[MODULE_ID]?.auriandriaRules)) add.push(featureData("rules"));
  if (![...actor.items].some(item => transitionOf(item) === opposite(form))) add.push(featureData(opposite(form)));
  for (const data of add) { delete data._id; data.folder = null; }
  if (add.length) await actor.createEmbeddedDocuments("Item", add);
}

export async function choosePartner(source, desired) {
  const saved = source.flags?.[MODULE_ID]?.auriandriaPartner;
  if (saved) {
    const actor = await fromUuid(saved);
    if (actor && !actor.pack && formOf(actor) === desired) return actor;
  }
  let matches = game.actors.filter(actor => actor.uuid !== source.uuid && formOf(actor) === desired
    && (actor.flags[MODULE_ID].auriandriaGroup ?? FORM_GROUP) === (source.flags?.[MODULE_ID]?.auriandriaGroup ?? FORM_GROUP));
  const sameFolder = matches.filter(actor => actor.folder?.id === source.folder?.id);
  if (sameFolder.length) matches = sameFolder;
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`Не найдена отдельная форма «${FORM_NAMES[desired]}» в списке персонажей мира.`);
  const escape = foundry.utils.escapeHTML;
  const selected = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Ауриандрия — выбрать форму ${FORM_NAMES[desired]}` },
    content: `<label>Лист формы <select name="partner">${matches.map(actor => `<option value="${actor.id}">${escape(actor.name)}</option>`).join("")}</select></label>`,
    ok: { label: "Выбрать", callback: (_event, button) => button.form.elements.partner.value }, rejectClose: false
  });
  return game.actors.get(selected);
}

export function tokenForActor(actor) {
  if (actor.isToken) return actor.token;
  const controlled = canvas.tokens?.controlled?.find(token => token.actor?.uuid === actor.uuid);
  return controlled?.document ?? actor.getActiveTokens?.()[0]?.document ?? null;
}

export async function performTransformation(request) {
  const user = game.users.get(request.userId);
  const source = await fromUuid(request.actorUuid);
  const feature = await fromUuid(request.itemUuid);
  const desired = transitionOf(feature);
  const target = await fromUuid(request.targetUuid);
  if (!user?.active || !source || !source.testUserPermission(user, "OWNER")
    || feature?.actor?.uuid !== source.uuid || !["sun", "moon"].includes(desired)
    || target?.pack || target?.documentName !== "Actor" || formOf(target) !== desired
    || target.uuid === source.uuid || formOf(source) === desired) {
    throw new Error("Невозможно выполнить это преображение для выбранных листов.");
  }
  const token = request.tokenUuid ? await fromUuid(request.tokenUuid) : null;
  if (token && (token.documentName !== "Token" || token.actor?.uuid !== source.uuid)) {
    throw new Error("Токен больше не соответствует исходной форме.");
  }
  const activeUUID = source.flags?.[MODULE_ID]?.auriandriaActiveActor;
  const baseUUID = source.isToken ? `Actor.${source.token.actorId}` : source.uuid;
  // Older versions moved resources and set these flags before their token update failed.
  const resume = activeUUID === target.uuid && token?.actor?.uuid === source.uuid
    && target.flags?.[MODULE_ID]?.auriandriaActiveActor === target.uuid
    && target.flags?.[MODULE_ID]?.auriandriaPartner === baseUUID;
  if (!resume && activeUUID && activeUUID !== source.uuid && activeUUID !== baseUUID && await fromUuid(activeUUID)) {
    throw new Error("Эта форма сейчас неактивна. Используйте преображение из текущего листа Ауриандрии.");
  }
  const key = [source.uuid, target.uuid].sort().join(":");
  if (pendingForms.has(key)) throw new Error("Преображение уже выполняется.");
  pendingForms.add(key);
  const journal = [];
  try {
    // Validate the token data before moving effects or marking either form inactive.
    const tokenData = token ? transformedTokenData(target) : null;
    await bindSpellPoints(source); await bindSpellPoints(target);
    const updates = resume ? null : sharedResourceUpdates(source, target);
    const ownership = { ...target.ownership };
    for (const [id, level] of Object.entries(source.ownership)) {
      if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ownership[id] = Math.max(ownership[id] ?? 0, level);
    }
    const original = source.isToken ? game.actors.get(source.token.actorId) ?? source : source;
    if (updates) {
      const restoreItems = updates.item.map(({ _id, ...changes }) => {
        const item = target.items.get(_id);
        return { _id, ...originalValues(item.toObject(), changes) };
      });
      journal.push(await transferBattleState(source, target));
      await updateWithRollback(target, updates.actor, journal);
      journal.push(() => target.updateEmbeddedDocuments("Item", restoreItems, { ...TRANSFER_OPTIONS }));
      await target.updateEmbeddedDocuments("Item", updates.item, { ...TRANSFER_OPTIONS });
      const hpMax = effectiveHPMaximum(target);
      if (Number.isFinite(hpMax) && target.system.attributes.hp.value > hpMax) {
        await updateWithRollback(target, { "system.attributes.hp.value": Math.max(0, hpMax) }, journal);
      }
    }
    await updateWithRollback(target, { ownership }, journal);
    await ensureFormButtons(original, opposite(desired));
    await ensureFormButtons(target, desired);
    if (token) {
      await updateWithRollback(token, tokenData, journal, { recursive: false });
      for (const combat of game.combats) {
        const combatant = combat.combatants.find(entry => entry.tokenId === token.id && (entry.sceneId ?? combat.scene?.id) === token.parent.id);
        if (combatant) await updateWithRollback(combatant, { actorId: target.id, name: token.name, img: token.texture.src }, journal);
      }
    }
    for (const player of game.users) {
      if ([source.uuid, original.uuid].includes(player.character?.uuid)) {
        // User.character is a document getter; updates store its ID.
        const character = player.character.id;
        journal.push(() => player.update({ character }));
        await player.update({ character: target.id });
      }
    }
    // Commit the active form only after the token and its combat entry have switched.
    await updateWithRollback(target, {
      [`flags.${MODULE_ID}.auriandriaPartner`]: original.uuid,
      [`flags.${MODULE_ID}.auriandriaActiveActor`]: target.uuid
    }, journal);
    await updateWithRollback(source, {
      [`flags.${MODULE_ID}.auriandriaPartner`]: target.uuid,
      [`flags.${MODULE_ID}.auriandriaActiveActor`]: target.uuid,
      [`flags.${MODULE_ID}.auriandriaForm`]: formOf(source) ?? opposite(desired)
    }, journal);
    if (original !== source) await updateWithRollback(original, {
      [`flags.${MODULE_ID}.auriandriaPartner`]: target.uuid,
      [`flags.${MODULE_ID}.auriandriaActiveActor`]: target.uuid,
      [`flags.${MODULE_ID}.auriandriaForm`]: formOf(source) ?? opposite(desired),
      [`flags.${MODULE_ID}.auriandriaGroup`]: FORM_GROUP
    }, journal);
    journal.length = 0;
    let burst;
    try { burst = await applyTransformationBurst(target, desired, token); }
    catch (error) {
      console.error(`${MODULE_ID} | Transformation burst`, error);
      ui.notifications.warn(`Форма изменена, но не удалось полностью применить эффекты поля боя: ${error.message}`);
      return { actorUuid: target.uuid, missingToken: !token };
    }
    const notes = [burst.missingToken ? "Токен на сцене не найден: эффекты поля боя не применялись." :
      `Спасброски: ${burst.enemies}; провалы: ${burst.failed}.${desired === "sun" ? ` Союзников получили лечение: ${burst.healed}.` : ""}`];
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: target, token }),
        content: `<p><strong>Ауриандрия: ${FORM_NAMES[desired]}.</strong> ${notes.join(" ")}</p>`
      });
    } catch (error) {
      console.error(`${MODULE_ID} | Transformation message`, error);
      ui.notifications.warn("Форма изменена, но не удалось отправить сообщение в чат.");
    }
    return { actorUuid: target.uuid, missingToken: Boolean(burst.missingToken) };
  } catch (error) {
    for (const undo of journal.reverse()) {
      try { await undo(); }
      catch (restoreError) { console.error(`${MODULE_ID} | Could not restore transformation`, restoreError); }
    }
    throw error;
  } finally { pendingForms.delete(key); }
}

import {
  CHAINS_ACTIVITY_ID,
  EXECUTOR_ID,
  FRIGHTENED_EFFECT_ID,
  GOLDEN_CHAINS_ID,
  MODULE_ID,
  isItem
} from "../lib/identifier.js";

const SOCKET = `module.${MODULE_ID}`;
const pendingDefense = new Map();
const spawning = new Set();
let registered = false;

export function registerExecutor() {
  if (registered) return;
  registered = true;
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("createActiveEffect", onCreateEffect);
  Hooks.on("deleteActiveEffect", onDeleteEffect);
  Hooks.on("updateActiveEffect", onUpdateEffect);
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("updateToken", onUpdateToken);
  game.socket.on(SOCKET, onSocket);
}

function onPostUseActivity(activity) {
  const item = activity?.item;
  const actor = item?.actor;
  if (!actor?.isOwner) return;

  if (isChainsItem(item)) {
    void contestGrapple(actor);
    return;
  }

  if (!isRageItem(item) || !hasExecutor(actor)) return;
  window.setTimeout(() => {
    if (isRaging(actor)) void ensureChains(actor);
    else void removeChains(actor);
  }, 50);
}

function onCreateEffect(effect, _options, userId) {
  if (game.user.id !== userId) return;
  const actor = effect.parent;
  if (actor?.documentName === "Actor" && marksIncapacitated(effect)) void releaseChainGrapples(actor);
  if (actor?.documentName !== "Actor" || !isRageEffect(effect)) return;
  if (!hasExecutor(actor) || !actor.isOwner) return;
  void ensureChains(actor);
}

function onDeleteEffect(effect, _options, userId) {
  if (game.user.id !== userId) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" || !isRageEffect(effect)) return;
  if (!hasExecutor(actor) || !actor.isOwner) return;
  if (isRaging(actor, effect)) return;
  void removeChains(actor);
}

function onUpdateEffect(effect, changes, _options, userId) {
  if (game.user.id !== userId || !("disabled" in (changes ?? {}))) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" || !isRageEffect(effect)) return;
  if (!hasExecutor(actor) || !actor.isOwner) return;
  if (changes.disabled) {
    if (!isRaging(actor, effect)) void removeChains(actor);
    return;
  }
  void ensureChains(actor);
}

function onUpdateCombat(combat, update) {
  if (!("round" in update) && !("turn" in update)) return;
  if (game.users.activeGM?.id !== game.user.id) return;
  void expireRetribution(combat);
}

function onSocket(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "defend" && data.userId === game.user.id) {
    void answerDefense(data);
    return;
  }
  if (data.type === "defenseResult" && pendingDefense.has(data.requestId)) {
    pendingDefense.get(data.requestId)(data.total);
    pendingDefense.delete(data.requestId);
    return;
  }
  if (data.type === "pull" && game.user.isGM && game.users.activeGM?.id === game.user.id) {
    void pullRemote(data);
    return;
  }
  if (data.type === "grapple" && game.user.isGM && game.users.activeGM?.id === game.user.id) {
    void createChainGrapple(data.grapplerUuid, data.targetUuid);
    return;
  }
  if (data.type === "releaseGrapple" && game.user.isGM && game.users.activeGM?.id === game.user.id) {
    void releaseRemote(data.effectUuid);
  }
}

function hasExecutor(actor) {
  return (actor?.items ?? []).some((item) => isItem(item, EXECUTOR_ID));
}

function isRageItem(item) {
  if (!item) return false;
  const identifier = `${item.system?.identifier || item.identifier || ""}`.toLowerCase();
  const name = item.name || "";
  return identifier === "rage" || /^rage$/i.test(name) || /^ярость$/i.test(name);
}

function isRageEffect(effect) {
  const origin = effect?.origin ? fromUuidSync(effect.origin) : null;
  const item = origin?.documentName === "Item"
    ? origin
    : origin?.parent?.documentName === "Item" ? origin.parent : null;
  if (isRageItem(item)) return true;
  const name = effect?.name || "";
  return /^rage$/i.test(name) || /^ярость$/i.test(name);
}

function isRaging(actor, except) {
  return (actor?.effects ?? []).some((effect) => effect !== except && !effect.disabled && isRageEffect(effect));
}

function isChainsItem(item) {
  return !!item?.getFlag?.(MODULE_ID, "goldenChains") || isItem(item, GOLDEN_CHAINS_ID);
}

function chainsItems(actor) {
  return (actor?.items ?? []).filter((item) => isChainsItem(item));
}

async function ensureChains(actor) {
  if (spawning.has(actor.uuid) || chainsItems(actor).length) return;
  spawning.add(actor.uuid);
  try {
    await actor.createEmbeddedDocuments("Item", [chainsItemData()]);
  } finally {
    spawning.delete(actor.uuid);
  }
}

async function removeChains(actor) {
  await releaseChainGrapples(actor);
  const items = chainsItems(actor);
  if (!items.length) return;
  await actor.deleteEmbeddedDocuments("Item", items.map((item) => item.id));
}

function chainsItemData() {
  return {
    name: "Golden Chains",
    type: "feat",
    img: "icons/commodities/metal/chain-steel.webp",
    system: {
      description: {
        value: "<p>As part of the Attack action, command the golden chains to grapple one creature within 15 feet, or 30 feet if your barbarian level is 10 or higher. You make an Athletics check. The target contests with Athletics or Acrobatics. If your result is higher, the creature is grappled and pulled to the nearest free space within 5 feet of you.</p>",
        chat: ""
      },
      source: {
        custom: "Autistic Premades Flame of Changes Edition",
        revision: 1,
        rules: "2014"
      },
      identifier: GOLDEN_CHAINS_ID,
      type: { value: "class", subtype: "" },
      requirements: "Executor of Judgement",
      activities: {
        [CHAINS_ACTIVITY_ID]: {
          _id: CHAINS_ACTIVITY_ID,
          type: "utility",
          name: "Golden Chains",
          sort: 0,
          activation: {
            type: "special",
            value: 1,
            condition: "Part of the Attack action",
            override: false
          },
          consumption: {
            targets: [],
            scaling: { allowed: false, max: "" },
            spellSlot: false
          },
          description: { chatFlavor: "" },
          duration: {
            concentration: false,
            value: "",
            units: "inst",
            special: "",
            override: false
          },
          effects: [],
          range: { units: "ft", value: "30", special: "", override: false },
          target: {
            template: { contiguous: false, type: "", size: "", units: "ft" },
            affects: { count: "1", type: "creature", choice: false, special: "" },
            override: false,
            prompt: true
          },
          uses: { spent: 0, max: "", recovery: [] },
          roll: { formula: "", name: "", prompt: false, visible: false }
        }
      }
    },
    effects: [],
    flags: {
      [MODULE_ID]: {
        identifier: GOLDEN_CHAINS_ID,
        goldenChains: true
      }
    }
  };
}

async function contestGrapple(actor) {
  const targets = [...(game.user.targets ?? [])];
  if (targets.length !== 1) {
    ui.notifications?.warn("Golden Chains: выберите одно существо.");
    return;
  }

  const targetToken = targets[0];
  const targetActor = targetToken.actor;
  if (!targetActor) {
    ui.notifications?.warn("Golden Chains: у цели нет актёра.");
    return;
  }

  const sourceToken = tokenForActor(actor);
  const reach = chainReach(actor);
  if (canvas.grid && sourceToken && sameScene(sourceToken, targetToken)) {
    const distance = tokenDistance(sourceToken, targetToken);
    if (Number.isFinite(distance) && distance > reach) {
      ui.notifications?.warn(`Golden Chains: цель дальше ${reach} футов.`);
      return;
    }
  }

  const attackRolls = await actor.rollSkill({ skill: "ath" });
  const attackTotal = attackRolls?.[0]?.total;
  if (!Number.isFinite(attackTotal)) return;

  const defenseTotal = await requestDefense(targetActor);
  if (!Number.isFinite(defenseTotal)) {
    await reportContest(actor, `${attackTotal} против отменённой проверки. Цель не сдвинута.`);
    return;
  }

  const won = attackTotal > defenseTotal;
  if (!won) {
    const outcome = attackTotal === defenseTotal
      ? "Ничья: цель не схвачена."
      : "Цель удержалась.";
    await reportContest(actor, `Атлетика ${attackTotal} против ${defenseTotal}. ${outcome}`);
    return;
  }

  let moved = false;
  if (sourceToken && sameScene(sourceToken, targetToken)) {
    const destination = nearestSpace(sourceToken, targetToken);
    if (destination) {
      await moveToken(targetToken, destination.x, destination.y);
      moved = true;
    }
  }

  await applyChainGrapple(actor, targetActor);
  const outcome = moved
    ? "Цель схвачена и притянута вплотную."
    : "Цель схвачена. Положение не менялось.";
  await reportContest(actor, `Атлетика ${attackTotal} против ${defenseTotal}. ${outcome}`);
}

function chainReach(actor) {
  const classes = actor.itemTypes?.class ?? [];
  let level = null;
  for (const cls of classes) {
    const identifier = cls.system?.identifier || cls.identifier || "";
    const name = cls.name || "";
    if (identifier === "barbarian" || /^barbarian$/i.test(name) || name === "Варвар") {
      level = Number(cls.system?.levels) || 0;
      break;
    }
  }
  if (level === null) level = Number(actor.system?.details?.level) || 0;
  return level >= 10 ? 30 : 15;
}

function tokenForActor(actor) {
  const controlled = canvas.tokens?.controlled?.find((token) => token.actor === actor);
  if (controlled) return controlled;
  return actor.getActiveTokens?.().find((token) => token.scene === canvas.scene)
    ?? actor.getActiveTokens?.()[0]
    ?? null;
}

function sameScene(source, target) {
  const sourceScene = source.scene?.id ?? source.document?.parent?.id ?? canvas.scene?.id;
  const targetScene = target.scene?.id ?? target.document?.parent?.id ?? null;
  return sourceScene && sourceScene === targetScene;
}

function cellCenter(cell) {
  const size = canvas.grid.size;
  return { x: cell.x + size / 2, y: cell.y + size / 2 };
}

function tokenDistance(source, target) {
  const sourceCells = occupiedCells(source);
  const targetCells = occupiedCells(target);
  let best = Infinity;
  for (const origin of sourceCells) {
    for (const cell of targetCells) {
      const distance = canvas.grid.measurePath([cellCenter(origin), cellCenter(cell)]).distance;
      if (distance < best) best = distance;
    }
  }
  return best;
}

function choosingUser(actor) {
  const player = game.users.find((user) => user.active && !user.isGM && actor.testUserPermission(user, "OWNER"));
  return player ?? game.users.activeGM ?? game.user;
}

async function requestDefense(actor) {
  const chooser = choosingUser(actor);
  if (chooser.id === game.user.id) return rollDefense(actor);
  const requestId = foundry.utils.randomID();
  const result = new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingDefense.delete(requestId);
      resolve(null);
    }, 60000);
    pendingDefense.set(requestId, (total) => {
      window.clearTimeout(timer);
      resolve(total);
    });
  });
  game.socket.emit(SOCKET, {
    type: "defend",
    requestId,
    actorUuid: actor.uuid,
    userId: chooser.id
  });
  return result;
}

async function answerDefense(data) {
  const actor = await fromUuid(data.actorUuid);
  const total = actor?.isOwner ? await rollDefense(actor) : null;
  game.socket.emit(SOCKET, { type: "defenseResult", requestId: data.requestId, total });
}

async function rollDefense(actor) {
  const skill = await chooseDefenseSkill();
  if (!skill) return null;
  const rolls = await actor.rollSkill({ skill });
  const total = rolls?.[0]?.total;
  return Number.isFinite(total) ? total : null;
}

async function chooseDefenseSkill() {
  const athletics = game.i18n.localize(CONFIG.DND5E.skills.ath?.label ?? "Athletics");
  const acrobatics = game.i18n.localize(CONFIG.DND5E.skills.acr?.label ?? "Acrobatics");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    try {
      const choice = await DialogV2.wait({
        window: { title: "Golden Chains" },
        content: "<p>Противопоставьте захвату Атлетику или Акробатику.</p>",
        buttons: [
          { action: "ath", label: athletics, default: true },
          { action: "acr", label: acrobatics }
        ],
        rejectClose: false
      });
      return choice === "ath" || choice === "acr" ? choice : null;
    } catch (error) {
      console.warn(`${MODULE_ID} | defense choice was cancelled`, error);
      return null;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    new Dialog({
      title: "Golden Chains",
      content: "<p>Противопоставьте захвату Атлетику или Акробатику.</p>",
      buttons: {
        ath: { label: athletics, callback: () => finish("ath") },
        acr: { label: acrobatics, callback: () => finish("acr") }
      },
      close: () => finish(null)
    }).render(true);
  });
}

function nearestSpace(source, target) {
  const grid = canvas.grid.size;
  const sourceDoc = source.document;
  const targetDoc = target.document;
  const width = targetDoc.width;
  const height = targetDoc.height;
  const occupied = occupiedCells(source);
  const origin = cellCenter({
    x: targetDoc.x + ((targetDoc.width - 1) * grid) / 2,
    y: targetDoc.y + ((targetDoc.height - 1) * grid) / 2
  });
  let best = null;

  const minX = sourceDoc.x - (width + 2) * grid;
  const maxX = sourceDoc.x + (sourceDoc.width + 2) * grid;
  const minY = sourceDoc.y - (height + 2) * grid;
  const maxY = sourceDoc.y + (sourceDoc.height + 2) * grid;

  for (let x = minX; x <= maxX; x += grid) {
    for (let y = minY; y <= maxY; y += grid) {
      if (!footprintWithinFiveFeet(x, y, width, height, occupied, grid)) continue;
      if (overlaps(x, y, width, height, sourceDoc, grid)) continue;
      if (blocked(x, y, width, height, target, grid)) continue;
      const center = { x: x + (width * grid) / 2, y: y + (height * grid) / 2 };
      const toTarget = canvas.grid.measurePath([origin, center]).distance;
      if (!best || toTarget < best.toTarget) best = { x, y, toTarget };
    }
  }
  return best;
}

function occupiedCells(token) {
  const grid = canvas.grid.size;
  const doc = token.document;
  const cells = [];
  for (let ix = 0; ix < doc.width; ix += 1) {
    for (let iy = 0; iy < doc.height; iy += 1) {
      cells.push({ x: doc.x + ix * grid, y: doc.y + iy * grid });
    }
  }
  return cells;
}

function footprintWithinFiveFeet(x, y, width, height, cells, grid) {
  for (let ix = 0; ix < width; ix += 1) {
    for (let iy = 0; iy < height; iy += 1) {
      const point = { x: x + ix * grid + grid / 2, y: y + iy * grid + grid / 2 };
      const close = cells.some((cell) => {
        const origin = { x: cell.x + grid / 2, y: cell.y + grid / 2 };
        const distance = canvas.grid.measurePath([origin, point]).distance;
        return distance > 0 && distance <= 5;
      });
      if (close) return true;
    }
  }
  return false;
}

function overlaps(x, y, width, height, doc, grid) {
  const left = x;
  const top = y;
  const right = x + width * grid;
  const bottom = y + height * grid;
  const otherRight = doc.x + doc.width * grid;
  const otherBottom = doc.y + doc.height * grid;
  return left < otherRight && right > doc.x && top < otherBottom && bottom > doc.y;
}

function blocked(x, y, width, height, ignore, grid) {
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.id === ignore.id) continue;
    if (overlaps(x, y, width, height, token.document, grid)) return true;
  }
  return false;
}

function onUpdateToken(doc, changes) {
  if (!("x" in changes) && !("y" in changes)) return;
  if (game.users.activeGM && game.users.activeGM.id !== game.user.id) return;
  void maintainChainGrapples(doc.actor);
}

async function applyChainGrapple(grappler, targetActor) {
  if (actorIncapacitated(grappler)) return;
  if (grappler.isOwner) await rememberChainGrapple(grappler, targetActor.uuid);
  if (targetActor.isOwner) {
    await createChainGrapple(grappler.uuid, targetActor.uuid);
    return;
  }
  game.socket.emit(SOCKET, {
    type: "grapple",
    grapplerUuid: grappler.uuid,
    targetUuid: targetActor.uuid
  });
}

async function createChainGrapple(grapplerUuid, targetUuid) {
  const grappler = await fromUuid(grapplerUuid);
  const target = await fromUuid(targetUuid);
  if (!grappler || !target?.isOwner) return;
  if (chainGrappleEffect(target, grappler.uuid)) return;
  if (target.effects.some((effect) => effect.statuses?.has("grappled"))) return;

  const effect = await ActiveEffect.implementation.fromStatusEffect("grappled");
  const data = effect.toObject();
  data.origin = grappler.uuid;
  data.flags ??= {};
  data.flags[MODULE_ID] = {
    chainGrapple: true,
    grappler: grappler.uuid
  };
  await ActiveEffect.implementation.create(data, { parent: target, keepId: true });
}

async function rememberChainGrapple(grappler, targetUuid) {
  const current = grappler.getFlag(MODULE_ID, "chainGrapples") ?? [];
  if (current.includes(targetUuid)) return;
  await grappler.setFlag(MODULE_ID, "chainGrapples", [...current, targetUuid]);
}

async function releaseChainGrapples(grappler) {
  const uuids = [...(grappler?.getFlag?.(MODULE_ID, "chainGrapples") ?? [])];
  for (const uuid of uuids) await releaseOne(grappler, uuid);
  if (grappler?.isOwner && grappler.getFlag(MODULE_ID, "chainGrapples")) {
    await grappler.unsetFlag(MODULE_ID, "chainGrapples");
  }
}

async function releaseOne(grappler, targetUuid) {
  const target = await fromUuid(targetUuid);
  const effect = chainGrappleEffect(target, grappler?.uuid);
  if (effect) {
    if (target.isOwner) await effect.delete();
    else game.socket.emit(SOCKET, { type: "releaseGrapple", effectUuid: effect.uuid });
  }
  if (!grappler?.isOwner) return;
  const remaining = (grappler.getFlag(MODULE_ID, "chainGrapples") ?? []).filter((uuid) => uuid !== targetUuid);
  if (remaining.length) await grappler.setFlag(MODULE_ID, "chainGrapples", remaining);
  else if (grappler.getFlag(MODULE_ID, "chainGrapples")) await grappler.unsetFlag(MODULE_ID, "chainGrapples");
}

async function releaseRemote(effectUuid) {
  const effect = await fromUuid(effectUuid);
  if (effect?.getFlag(MODULE_ID, "chainGrapple")) await effect.delete();
}

function chainGrappleEffect(actor, grapplerUuid) {
  return actor?.effects?.find((effect) =>
    effect.getFlag(MODULE_ID, "chainGrapple") && effect.getFlag(MODULE_ID, "grappler") === grapplerUuid
  ) ?? null;
}

async function maintainChainGrapples(actor) {
  if (!actor) return;
  const grapplerUuids = new Set(actor.getFlag(MODULE_ID, "chainGrapples") ?? []);
  for (const effect of actor.effects) {
    const grapplerUuid = effect.getFlag(MODULE_ID, "grappler");
    if (effect.getFlag(MODULE_ID, "chainGrapple") && grapplerUuid) grapplerUuids.add(grapplerUuid);
  }

  for (const grapplerUuid of grapplerUuids) {
    const grappler = grapplerUuid === actor.uuid ? actor : await fromUuid(grapplerUuid);
    if (!grappler) continue;
    if (actorIncapacitated(grappler)) {
      await releaseChainGrapples(grappler);
      continue;
    }
    const targets = grappler.getFlag(MODULE_ID, "chainGrapples") ?? [];
    for (const targetUuid of [...targets]) {
      if (!(await chainStillHolds(grappler, targetUuid))) await releaseOne(grappler, targetUuid);
    }
  }
}

async function chainStillHolds(grappler, targetUuid) {
  const target = await fromUuid(targetUuid);
  if (!target || !chainGrappleEffect(target, grappler.uuid)) return false;
  const source = tokenForActor(grappler);
  const targetToken = tokenForActor(target);
  if (!canvas.grid || !source || !targetToken || !sameScene(source, targetToken)) return true;
  const distance = tokenDistance(source, targetToken);
  return !Number.isFinite(distance) || distance <= chainReach(grappler);
}

function actorIncapacitated(actor) {
  const statuses = actor?.statuses;
  if (!statuses) return false;
  return ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"].some((id) => statuses.has(id));
}

function marksIncapacitated(effect) {
  const statuses = effect?.statuses;
  if (!statuses) return false;
  return ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"].some((id) => statuses.has(id));
}

async function moveToken(token, x, y) {
  const doc = token.document;
  if (doc.canUserModify(game.user, "update")) {
    await doc.update({ x, y });
    return;
  }
  game.socket.emit(SOCKET, { type: "pull", uuid: doc.uuid, x, y });
}

async function pullRemote(data) {
  const doc = await fromUuid(data.uuid);
  if (!doc) return;
  await doc.update({ x: data.x, y: data.y });
}

async function reportContest(actor, text) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>Golden Chains.</strong> ${text}</p>`
  });
}

async function expireRetribution(combat) {
  const turns = combat.turns ?? [];
  const count = turns.length;
  const previous = combat.previous;
  if (!count || !Number.isFinite(previous?.round) || !Number.isFinite(previous?.turn)) return;

  const newTime = (combat.round ?? 0) * count + (combat.turn ?? 0);
  const oldTime = previous.round * count + previous.turn;
  if (newTime <= oldTime) return;

  const ending = [];
  for (let index = 0; index < count; index += 1) {
    const actor = turns[index]?.actor;
    if (!actor) continue;
    for (let time = oldTime; time < newTime; time += 1) {
      if (time % count !== index) continue;
      for (const effect of actor.effects) {
        if (!isRetribution(effect) || ending.includes(effect)) continue;
        const start = (effect.duration?.startRound ?? 0) * count + (effect.duration?.startTurn ?? 0);
        if (time > start) ending.push(effect);
      }
    }
  }
  for (const effect of ending) {
    if (!effect.parent) continue;
    try {
      await effect.delete();
    } catch (error) {
      console.warn(`${MODULE_ID} | retribution effect was already removed`, error);
    }
  }
}

function isRetribution(effect) {
  return effect.getFlag?.(MODULE_ID, "retribution") === true
    || `${effect.origin || ""}`.includes(FRIGHTENED_EFFECT_ID);
}

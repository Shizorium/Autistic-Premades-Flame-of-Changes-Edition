import { MODULE_ID } from "../lib/identifier.js";
import { transitionOf } from "./data.js";
import { choosePartner, performTransformation, tokenForActor } from "./forms.js";
import { expireAuriandriaConditions } from "./battlefield.js";
import { ensureAuriandriaLibrary } from "./library.js";
import { registerAuriandriaSpellPoints } from "./spellpoints.js";
import { registerAuriandriaState, restoreAuriandriaEffectTemplates } from "./state.js";

const SOCKET = `module.${MODULE_ID}`;
const requests = new Map();
const inUse = new Set();
const processed = new Set();

export function registerAuriandria() {
  registerAuriandriaState();
  game.socket.on(SOCKET, onSocket);
  Hooks.on("dnd5e.postUseActivity", activity => {
    if (transitionOf(activity.item) && activity.actor?.isOwner) void useTransformation(activity.item);
  });
  Hooks.on("updateCombat", (combat, changes) => {
    if ("turn" in changes || "round" in changes) void expireAuriandriaConditions(combat);
  });
  Hooks.on("deleteCombat", combat => { void expireAuriandriaConditions(combat, { deleted: true }); });
  Hooks.on("updateWorldTime", worldTime => { void expireAuriandriaConditions(null, { worldTime }); });
}

export async function readyAuriandria() {
  for (const initialize of [registerAuriandriaSpellPoints, ensureAuriandriaLibrary, restoreAuriandriaEffectTemplates]) {
    try { await initialize(); }
    catch (error) { reportError(error); }
  }
}

function reportError(error) {
  console.error(`${MODULE_ID} | Auriandria`, error);
  ui.notifications.error(`Ауриандрия: ${error.message}`);
}

export async function useTransformation(item) {
  const actor = item.actor;
  if (!actor?.isOwner || inUse.has(actor.uuid)) return;
  inUse.add(actor.uuid);
  try {
    const target = await choosePartner(actor, transitionOf(item));
    if (!target) return;
    const token = tokenForActor(actor);
    const request = {
      type: "auriandriaTransform", requestId: foundry.utils.randomID(), userId: game.user.id,
      actorUuid: actor.uuid, itemUuid: item.uuid, targetUuid: target.uuid, tokenUuid: token?.uuid
    };
    let result;
    if (game.user.isGM) result = await performTransformation(request);
    else {
      if (!game.users.activeGM) throw new Error("Для преображения и эффектов поля боя нужен подключённый ведущий.");
      result = await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          requests.delete(request.requestId); reject(new Error("Ведущий не ответил на запрос преображения."));
        }, 60000);
        requests.set(request.requestId, data => {
          window.clearTimeout(timer); requests.delete(request.requestId);
          data.error ? reject(new Error(data.error)) : resolve(data.result);
        });
        game.socket.emit(SOCKET, request);
      });
    }
    const transformed = await fromUuid(result.actorUuid);
    // A Tidy sheet can submit stale fields on close after its battle state has moved.
    if (actor.sheet?.rendered) await actor.sheet.close({ submit: false });
    await transformed?.sheet?.render(true);
    if (result.missingToken) ui.notifications.warn("Форма изменена без токена; эффекты поля боя не применялись.");
  } catch (error) { reportError(error); }
  finally { inUse.delete(actor.uuid); }
}

async function onSocket(data) {
  if (data?.type === "auriandriaResult" && data.userId === game.user.id) {
    requests.get(data.requestId)?.(data);
    return;
  }
  if (data?.type !== "auriandriaTransform" || game.users.activeGM?.id !== game.user.id || processed.has(data.requestId)) return;
  if (typeof data.requestId !== "string" || !data.requestId || typeof data.userId !== "string") return;
  processed.add(data.requestId);
  window.setTimeout(() => processed.delete(data.requestId), 120000);
  const response = { type: "auriandriaResult", requestId: data.requestId, userId: data.userId };
  try { response.result = await performTransformation(data); }
  catch (error) { response.error = error.message; reportError(error); }
  game.socket.emit(SOCKET, response);
}

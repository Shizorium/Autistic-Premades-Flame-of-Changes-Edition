import { MODULE_ID } from "../lib/identifier.js";
import { clericLevel, sacredFlameDice } from "./data.js";

function occupiedCenters(token, grid) {
  const points = [];
  const width = Number(token.width) || 1, height = Number(token.height) || 1;
  for (let x = 0; x < Math.ceil(width); x++) for (let y = 0; y < Math.ceil(height); y++) {
    points.push({ x: token.x + (x + Math.min(1, width - x) / 2) * grid.size,
      y: token.y + (y + Math.min(1, height - y) / 2) * grid.size });
  }
  return points;
}

export function tokenDistanceFeet(source, target) {
  const grid = source.parent.grid;
  let distance = Infinity;
  for (const origin of occupiedCenters(source, grid)) for (const destination of occupiedCenters(target, grid)) {
    const planar = grid.measurePath([origin, destination]).distance;
    const elevation = Math.abs((source.elevation ?? 0) - (target.elevation ?? 0));
    distance = Math.min(distance, Math.hypot(planar, elevation));
  }
  const unit = String(grid.units ?? "").toLowerCase();
  return /^(m|м|метр|meters?|metres?)/.test(unit) ? distance / 0.3048 : distance;
}

export function battlefieldTargets(source) {
  const allies = new Map(), enemies = new Map();
  const disposition = Number(source.disposition);
  if (!disposition) return { allies: [], enemies: [] };
  for (const token of source.parent.tokens) {
    if (token.id === source.id || !token.actor || token.actor.uuid === source.actor?.uuid) continue;
    if (Number(token.disposition) === disposition) allies.set(token.actor.uuid, token);
    else if (Number(token.disposition) === -disposition && tokenDistanceFeet(source, token) <= 15 + 1e-6) {
      enemies.set(token.actor.uuid, token);
    }
  }
  return { allies: [...allies.values()], enemies: [...enemies.values()] };
}

export function expiryForSource(source, combat) {
  const index = combat?.turns?.findIndex(turn => turn.tokenId === source.id
    && (turn.sceneId ?? combat.scene?.id) === source.parent.id) ?? -1;
  if (index < 0 || !combat.started) return { worldTime: (game.time.worldTime ?? 0) + 6 };
  return {
    combatId: combat.id, combatantId: combat.turns[index].id,
    round: (combat.round ?? 1) + (index <= (combat.turn ?? 0) ? 1 : 0)
  };
}

export function hasReachedExpiry(expiry, combat) {
  if (expiry.combatId !== combat.id || !combat.previous) return false;
  const sourceIndex = combat.turns.findIndex(turn => turn.id === expiry.combatantId);
  if (sourceIndex < 0) return true;
  const count = combat.turns.length;
  const oldTime = combat.previous.round * count + combat.previous.turn;
  const newTime = combat.round * count + combat.turn;
  const expiryTime = expiry.round * count + sourceIndex;
  return oldTime <= expiryTime && expiryTime < newTime;
}

async function applyCondition(actor, status, source, expiry) {
  if (actor.system.traits?.ci?.value?.has(status)) return;
  const existing = [...actor.effects].find(effect => effect.flags?.[MODULE_ID]?.auriandriaCondition
    && effect.flags[MODULE_ID].sourceToken === source.uuid && effect.statuses.has(status));
  const effect = await ActiveEffect.implementation.fromStatusEffect(status);
  const data = effect.toObject(); delete data._id;
  data.origin = source.actor.uuid;
  data.duration = {};
  data.flags ??= {};
  data.flags[MODULE_ID] = { auriandriaCondition: true, sourceToken: source.uuid, expiry };
  if (existing) await existing.update({ ...data, _id: existing.id });
  else await actor.createEmbeddedDocuments("ActiveEffect", [data]);
}

export function spellSaveDC(actor) {
  const ability = actor.system.attributes.spellcasting || "wis";
  return Number(actor.system.abilities?.[ability]?.dc ?? actor.system.attributes.spell?.dc)
    || 8 + (Number(actor.system.attributes.prof) || 0) + (Number(actor.system.abilities?.[ability]?.mod) || 0);
}

export async function applyTransformationBurst(actor, form, source) {
  if (!source) return { missingToken: true, healed: 0, failed: 0, enemies: 0 };
  const { allies, enemies } = battlefieldTargets(source);
  const dc = spellSaveDC(actor);
  const combat = game.combats.find(c => c.scene?.id === source.parent.id && c.started);
  const expiry = expiryForSource(source, combat);
  const result = { healed: 0, failed: 0, enemies: enemies.length };
  if (form === "sun") {
    const healing = 5 * clericLevel(actor);
    for (const ally of allies) {
      await ally.actor.applyDamage([{ value: healing, type: "healing" }]);
      result.healed++;
    }
  }
  let damage;
  for (const enemy of enemies) {
    const rolls = await enemy.actor.rollSavingThrow({
      ability: form === "moon" ? "wis" : "dex", target: dc,
      // Sacred Flame receives no half/three-quarter-cover bonus to its save.
      ...(form === "sun" ? { rolls: [{ data: { cover: 0 } }] } : {})
    }, { configure: false }, { data: { flavor: `${actor.name}: ${form === "moon" ? "Луна" : "Солнце"} — Сл ${dc}` } });
    const total = rolls?.[0]?.total;
    if (!Number.isFinite(total)) throw new Error(`Не удалось бросить спасбросок для ${enemy.name}.`);
    if (total >= dc) continue;
    result.failed++;
    if (form === "sun") {
      if (!damage) {
        const level = Number(actor.system.details.level) || clericLevel(actor);
        damage = await new CONFIG.Dice.DamageRoll(`${sacredFlameDice(level)}d8`, {}, { type: "radiant" }).evaluate();
        await damage.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: "Солнце — Священное пламя (излучение)" });
      }
      await enemy.actor.applyDamage([{ value: damage.total, type: "radiant" }]);
    }
    await applyCondition(enemy.actor, form === "moon" ? "frightened" : "blinded", source, expiry);
  }
  return result;
}

export async function expireAuriandriaConditions(combat, { deleted = false, worldTime } = {}) {
  if (game.users.activeGM?.id !== game.user.id) return;
  const actors = new Map([...game.actors].map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes) for (const token of scene.tokens) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) {
    const expired = [...actor.effects].filter(effect => {
      const flags = effect.flags?.[MODULE_ID];
      if (!flags?.auriandriaCondition) return false;
      const expiry = flags.expiry;
      if (worldTime !== undefined) return expiry.worldTime !== undefined && expiry.worldTime <= worldTime;
      return expiry.combatId === combat.id && (deleted || hasReachedExpiry(expiry, combat));
    });
    if (expired.length) await actor.deleteEmbeddedDocuments("ActiveEffect", expired.map(effect => effect.id));
  }
}

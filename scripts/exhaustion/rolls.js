import { clampExhaustion, exhaustionPenalty, ROLL_KEY, ROLL_PART } from "./config.js";

// Keep the penalty as an actual, labelled roll term, never a modification of a result.
export function addExhaustionToRoll(actor, parts, data) {
  if (!actor || !Array.isArray(parts) || !data) return;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "@exhaustion" || String(parts[i]).includes(`@${ROLL_KEY}`)) parts.splice(i, 1);
  }
  delete data[ROLL_KEY];
  const level = clampExhaustion(actor.system?.attributes?.exhaustion);
  const penalty = exhaustionPenalty(level);
  if (!penalty) return;
  parts.push(ROLL_PART);
  data[ROLL_KEY] = -penalty;
}

export function registerExhaustionRolls() {
  // The system calls this for attacks, checks, saves, concentration, death saves and initiative.
  CONFIG.Actor.documentClass.prototype.addRollExhaustion = function(parts, data) {
    addExhaustionToRoll(this, parts, data);
  };
  // Also covers flat attack bonuses and additional d20 rolls built by other modules.
  Hooks.on("dnd5e.postBuildD20TestRollConfig", addConfigPenalty);
  // Utility activities may explicitly roll a d20 through BasicRoll instead of D20Roll.
  Hooks.on("dnd5e.postBuildFormulaRollConfig", (process, config) => {
    const formula = CONFIG.Dice.BasicRoll.replaceFormulaData((config.parts ?? []).join(" + "), config.data ?? {}, { missing: "0" });
    if (/(?:^|[^a-z0-9_])\d*d20(?!\d)/i.test(formula)) addConfigPenalty(process, config);
  });
}

function addConfigPenalty(process, config) {
  const subject = config.subject ?? process.subject;
  const actor = subject?.documentName === "Actor" ? subject : subject?.actor;
  if (!actor) return;
  config.parts ??= [];
  config.data ??= {};
  addExhaustionToRoll(actor, config.parts, config.data);
}

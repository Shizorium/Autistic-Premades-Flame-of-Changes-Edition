import { MODULE_ID } from "../lib/identifier.js";
import { exhaustionEnabled, initializeExhaustionMode, registerExhaustionSettings } from "./config.js";
import { reconcileExhaustionActors, registerExhaustionEffects, setExhaustion } from "./effects.js";
import { ensureExhaustionPack } from "./compendium.js";
import { registerExhaustionRolls } from "./rolls.js";
import { configureExhaustionRules, configureTidyExhaustion, registerExhaustionSheets } from "./sheets.js";

let refresh = Promise.resolve();

export function initExhaustion() {
  registerExhaustionSettings(() => {
    if (game.ready) void refreshExhaustion();
  });
  initializeExhaustionMode();
  if (!exhaustionEnabled()) return;
  registerExhaustionSheets();
  Hooks.once("setup", () => {
    configureExhaustionRules();
    registerExhaustionEffects();
    registerExhaustionRolls();
  });
}

export function refreshExhaustion() {
  refresh = refresh.catch(() => {}).then(async () => {
    if (!exhaustionEnabled()) {
      await configureTidyExhaustion();
      return;
    }
    configureExhaustionRules();
    await configureTidyExhaustion();
    await reconcileExhaustionActors();
    await ensureExhaustionPack();
  }).catch(error => {
    console.error(`${MODULE_ID} | Exhaustion configuration failed`, error);
    ui.notifications?.error("Flame of Changes: не удалось настроить истощение. Подробности в консоли (F12).");
  });
  return refresh;
}

export { setExhaustion };

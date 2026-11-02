import { MODULE_ID } from "../lib/identifier.js";
import { exhaustionConfig, exhaustionEnabled, exhaustionPenalty } from "./config.js";

let tidyApi;

export function configureExhaustionRules() {
  if (!exhaustionEnabled()) return;
  const config = exhaustionConfig();
  const exhaustion = CONFIG.DND5E.conditionTypes.exhaustion;
  exhaustion.levels = config.maxLevel;
  exhaustion.reduction = { ...exhaustion.reduction, rolls: 0, speed: 0 };
  // Legacy (2014) conditions must not halve HP/speed or introduce disadvantage.
  for (const conditions of Object.values(CONFIG.DND5E.conditionEffects)) {
    if (!(conditions instanceof Set)) continue;
    for (const condition of conditions) if (/^exhaustion-\d+$/.test(condition)) conditions.delete(condition);
  }
}

export function registerExhaustionSheets() {
  Hooks.on("tidy5e-sheet.ready", api => {
    tidyApi = api;
  });
}

export async function configureTidyExhaustion() {
  if (game.users.activeGM?.id !== game.user.id || !game.modules.get("tidy5e-sheet")?.active) return;
  const current = game.settings.get("tidy5e-sheet", "exhaustionConfig");
  const useExhaustion = game.settings.get("tidy5e-sheet", "useExhaustion");
  const backup = game.settings.get(MODULE_ID, "exhaustionTidyBackup");
  // Older module versions already stored custom hints in Tidy without a backup.
  const managed = current?.type === "specific" && current.hints?.[0] === "Нет истощения"
    && current.hints.slice(1).every(hint => /^Истощение \d+: −[\d.]+ ко всем броскам d20\.$/.test(hint));
  const native = game.settings.settings?.get("tidy5e-sheet.exhaustionConfig")?.default
    ?? { type: "specific", levels: 6, hints: [] };
  if (!exhaustionEnabled()) {
    const restored = backup?.captured ? backup.config : managed ? native : null;
    if (restored && JSON.stringify(current) !== JSON.stringify(restored)) {
      await game.settings.set("tidy5e-sheet", "exhaustionConfig", restored);
    }
    if (backup?.captured) {
      if (useExhaustion !== backup.useExhaustion) await game.settings.set("tidy5e-sheet", "useExhaustion", backup.useExhaustion);
      await game.settings.set(MODULE_ID, "exhaustionTidyBackup", {});
    }
    return;
  }
  if (!backup?.captured) {
    await game.settings.set(MODULE_ID, "exhaustionTidyBackup", {
      captured: true, config: managed ? native : current, useExhaustion
    });
  }
  const config = exhaustionConfig();
  const hints = Array.from({ length: config.maxLevel + 1 }, (_, level) => level
    ? `Истощение ${level}: −${exhaustionPenalty(level, config)} ко всем броскам d20.`
    : "Нет истощения");
  const desired = { type: "specific", hints, levels: config.maxLevel };
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    const api = tidyApi ?? game.modules.get("tidy5e-sheet")?.api;
    const exhaustionApi = api?.config?.exhaustion ?? api?.exhaustion;
    if (exhaustionApi?.useSpecificLevelExhaustion) {
      await exhaustionApi.useSpecificLevelExhaustion({ totalLevels: config.maxLevel, hints });
    } else await game.settings.set("tidy5e-sheet", "exhaustionConfig", desired);
  }
  if (!game.settings.get("tidy5e-sheet", "useExhaustion")) {
    await game.settings.set("tidy5e-sheet", "useExhaustion", true);
  }
}

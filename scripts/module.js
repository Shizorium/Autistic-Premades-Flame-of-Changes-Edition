import { MODULE_ID } from "./lib/identifier.js";
import { ensureFeaturePack } from "./lib/pack.js";
import { registerResolve } from "./features/resolve.js";
import { registerExecutor } from "./features/executor.js";
import { initExhaustion, refreshExhaustion, setExhaustion } from "./exhaustion/index.js";
import { readyAuriandria, registerAuriandria, useTransformation } from "./auriandria/index.js";

Hooks.once("init", () => {
  initExhaustion();
  game.modules.get(MODULE_ID).api = { setExhaustion, useTransformation };
  console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", async () => {
  registerResolve();
  registerExecutor();
  registerAuriandria();
  await ensureFeaturePack();
  await refreshExhaustion();
  await readyAuriandria();
});

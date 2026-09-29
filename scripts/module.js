import { MODULE_ID } from "./lib/identifier.js";
import { ensureFeaturePack } from "./lib/pack.js";
import { registerResolve } from "./features/resolve.js";
import { registerExecutor } from "./features/executor.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", () => {
  registerResolve();
  registerExecutor();
  void ensureFeaturePack();
});

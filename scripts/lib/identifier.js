export const MODULE_ID = "Autistic_Premades_Flame_of_Changes_Edition";
export const PACK_NAME = "features";
export const RESOLVE_ID = "resolve";
export const RESOLVE_ITEM_ID = "apfceResolve0001";
export const RESOLVE_FOLDER_ID = "apfceMageHunt001";
export const RESOLVE_FOLDER_NAME = "Mage hunter";
export const RESOLVE_JSON = `modules/${MODULE_ID}/pack-src/features/resolve.json`;
export const EXECUTOR_ID = "executor-of-judgement";
export const EXECUTOR_ITEM_ID = "apfceExecutor001";
export const EXECUTOR_FOLDER_ID = "apfceArbiter0001";
export const EXECUTOR_FOLDER_NAME = "Arbiter of Light";
export const EXECUTOR_JSON = `modules/${MODULE_ID}/pack-src/features/executor-of-judgement.json`;
export const FRIGHTENED_EFFECT_ID = "apfceFrighten001";
export const GOLDEN_CHAINS_ID = "golden-chains";
export const CHAINS_ACTIVITY_ID = "apfceChainsAct01";

export const PACK_ENTRIES = [
  {
    itemId: RESOLVE_ITEM_ID,
    folderId: RESOLVE_FOLDER_ID,
    folderName: RESOLVE_FOLDER_NAME,
    color: "#7a1f2b",
    json: RESOLVE_JSON
  },
  {
    itemId: EXECUTOR_ITEM_ID,
    folderId: EXECUTOR_FOLDER_ID,
    folderName: EXECUTOR_FOLDER_NAME,
    color: "#c9a227",
    json: EXECUTOR_JSON
  }
];

export function getItemIdentifier(item) {
  return item?.flags?.[MODULE_ID]?.identifier || item?.system?.identifier || "";
}

export function isItem(item, identifier) {
  return getItemIdentifier(item) === identifier;
}

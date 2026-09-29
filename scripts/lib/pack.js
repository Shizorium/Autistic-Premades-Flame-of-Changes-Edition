import { MODULE_ID, PACK_ENTRIES, PACK_NAME } from "./identifier.js";

export async function ensureFeaturePack() {
  if (!game.user?.isGM) return;

  const pack = game.packs.get(`${MODULE_ID}.${PACK_NAME}`);
  if (!pack) {
    console.warn(`${MODULE_ID} | pack ${PACK_NAME} not found`);
    return;
  }

  const index = pack.index?.size ? pack.index : await pack.getIndex();
  const pending = [];
  for (const entry of PACK_ENTRIES) {
    if (!index.get(entry.itemId)) {
      pending.push(entry);
      continue;
    }
    const existing = await pack.getDocument(entry.itemId);
    const folderId = existing?.folder?.id ?? existing?.folder ?? null;
    if (!folderId) pending.push(entry);
  }
  if (!pending.length) return;

  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  if (pack.locked) {
    console.error(`${MODULE_ID} | ${pack.collection} stayed locked, so new features were not added`);
    ui.notifications?.error("Flame of Changes: компендиум заперт, новые особенности не записались.");
    return;
  }

  try {
    for (const entry of pending) await ensureEntry(pack, entry);
  } catch (error) {
    console.error(`${MODULE_ID} | failed to fill the features compendium`, error);
    ui.notifications?.error("Flame of Changes: не удалось заполнить компендиум. Подробности в консоли (F12).");
  } finally {
    if (wasLocked && !pack.locked) await pack.configure({ locked: true });
  }
}

async function ensureEntry(pack, entry) {
  const folder = await ensureFolder(pack, entry);
  const index = await pack.getIndex();
  if (index.get(entry.itemId)) {
    const existing = await pack.getDocument(entry.itemId);
    if (existing && !existing.folder && folder) await existing.update({ folder: folder.id });
    return;
  }

  const data = await foundry.utils.fetchJsonWithTimeout(entry.json);
  const payload = foundry.utils.duplicate(data);
  payload._id = entry.itemId;
  payload.folder = folder?.id ?? null;
  const created = await Item.create(payload, { pack: pack.collection, keepId: true });
  if (!created) throw new Error(`Item.create returned no document for ${entry.itemId}`);
  console.log(`${MODULE_ID} | imported ${payload.name} into ${pack.collection}`);
}

async function ensureFolder(pack, entry) {
  const folders = pack.folders ?? [];
  const existing = folders.get?.(entry.folderId)
    ?? [...folders].find((folder) => folder.name === entry.folderName);
  if (existing) return existing;

  try {
    const created = await Folder.create({
      _id: entry.folderId,
      name: entry.folderName,
      type: "Item",
      sorting: "a",
      color: entry.color,
      folder: null
    }, { pack: pack.collection, keepId: true });
    const folder = Array.isArray(created) ? created[0] : created;
    if (!folder) throw new Error(`Folder.create returned no document for ${entry.folderName}`);
    return folder;
  } catch (error) {
    console.warn(`${MODULE_ID} | folder ${entry.folderName} was not created`, error);
    const retry = pack.folders?.get?.(entry.folderId)
      ?? [...(pack.folders ?? [])].find((folder) => folder.name === entry.folderName);
    return retry ?? null;
  }
}

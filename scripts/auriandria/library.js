import { MODULE_ID, PACK_NAME } from "../lib/identifier.js";
import {
  AURIANDRIA_ACTOR_PACK, AURIANDRIA_FOLDER_ID, FEATURE_IDS, FORM_IDS,
  featureData, formOf
} from "./data.js";
import { bindSpellPoints } from "./spellpoints.js";

async function unlocked(pack, work) {
  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });
    if (pack.locked) throw new Error(`Компендиум ${pack.collection} заперт.`);
    return await work();
  } finally {
    if (wasLocked && !pack.locked) await pack.configure({ locked: true });
  }
}

async function ensureFolder(pack, type) {
  const found = pack.folders.get(AURIANDRIA_FOLDER_ID);
  if (found) return found;
  return Folder.create({
    _id: AURIANDRIA_FOLDER_ID, name: "Ауриандрия", type, color: "#cda453", sorting: "a"
  }, { pack: pack.collection, keepId: true });
}

export async function ensureAuriandriaLibrary({ formSources = [] } = {}) {
  if (game.users.activeGM?.id !== game.user.id) return;
  const features = game.packs.get(`${MODULE_ID}.${PACK_NAME}`);
  if (!features) throw new Error("Не найден компендиум Flame of Changes.");
  const featureIndex = await features.getIndex();
  if (!features.folders.get(AURIANDRIA_FOLDER_ID) || Object.values(FEATURE_IDS).some(id => !featureIndex.get(id))) {
    await unlocked(features, async () => {
      await ensureFolder(features, "Item");
      for (const kind of ["rules", "sun", "moon"]) {
        if (!featureIndex.get(FEATURE_IDS[kind])) await Item.create(featureData(kind), { pack: features.collection, keepId: true });
      }
    });
  }
  // A world compendium can be registered immediately, without restarting the
  // server to discover a new module manifest. It contains templates, not actors
  // in the world's Actor directory.
  const forms = game.packs.get(`world.${AURIANDRIA_ACTOR_PACK}`)
    ?? await foundry.documents.collections.CompendiumCollection.createCompendium({
      name: AURIANDRIA_ACTOR_PACK, label: "Ауриандрия — формы", type: "Actor"
    });
  const formIndex = await forms.getIndex();
  if (!forms.folders.get(AURIANDRIA_FOLDER_ID) || Object.values(FORM_IDS).some(id => !formIndex.get(id))) {
    await unlocked(forms, async () => {
      await ensureFolder(forms, "Actor");
      for (const form of ["sun", "moon"]) {
        if (formIndex.get(FORM_IDS[form])) continue;
        const candidates = game.actors.filter(actor => formOf(actor) === form);
        const source = formSources.find(actor => formOf(actor) === form)
          ?? (candidates.length === 1 ? candidates[0] : null);
        const data = source ? source.toCompendium(forms, { clearFolder: true, clearState: false, clearOwnership: false })
          : await foundry.utils.fetchJsonWithTimeout(`modules/${MODULE_ID}/pack-src/auriandria/${form}.json`);
        data._id = FORM_IDS[form]; data.folder = AURIANDRIA_FOLDER_ID;
        const flags = data.flags[MODULE_ID];
        delete flags.auriandriaPartner; delete flags.auriandriaActiveActor;
        if (source) flags.auriandriaArchivedFrom = source.uuid;
        await Actor.create(data, { pack: forms.collection, keepId: true, keepEmbeddedIds: true });
      }
    });
  }
  for (const actor of game.actors) if (formOf(actor)) await bindSpellPoints(actor);
  return forms;
}

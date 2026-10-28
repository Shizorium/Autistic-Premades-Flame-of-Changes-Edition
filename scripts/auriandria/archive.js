import { MODULE_ID } from "../lib/identifier.js";
import { FORM_IDS, formOf } from "./data.js";
import { ensureAuriandriaLibrary } from "./library.js";

function comparable(data) {
  const flags = foundry.utils.deepClone(data.flags ?? {});
  for (const key of ["auriandriaPartner", "auriandriaActiveActor", "auriandriaArchivedFrom"]) {
    if (flags[MODULE_ID]) delete flags[MODULE_ID][key];
  }
  // Scene Packer recalculates this checksum when the document UUID changes.
  // Its other flags, and all gameplay data, must still match exactly.
  if (flags["scene-packer"]) delete flags["scene-packer"].hash;
  const normalize = value => {
    if (Array.isArray(value)) {
      const entries = value.every(entry => entry?._id) ? [...value].sort((a, b) => a._id.localeCompare(b._id)) : value;
      return entries.map(normalize);
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
      .filter(key => key !== "_stats").map(key => [key, normalize(value[key])]));
    return value;
  };
  return JSON.stringify(normalize({ name: data.name, type: data.type, img: data.img,
    system: data.system, items: data.items, effects: data.effects, flags }));
}

/** Explicit relocation only. Ordinary module initialization never removes world actors. */
export async function moveAuriandriaFormsToCompendium(actorIds) {
  if (!game.user.isGM) throw new Error("Перенос выполняет ведущий.");
  const actors = [...new Set(actorIds)].map(id => game.actors.get(id));
  if (!actors.length || actors.some(actor => !actor || actor.pack || !FORM_IDS[formOf(actor)])
    || new Set(actors.map(formOf)).size !== actors.length) throw new Error("Выберите по одному листу каждой формы Ауриандрии.");
  for (const actor of actors) {
    const used = game.scenes.some(scene => scene.tokens.some(token => token.actorId === actor.id))
      || game.combats.some(combat => combat.combatants.some(combatant => combatant.actorId === actor.id))
      || game.users.some(user => (user.character?.id ?? user.character) === actor.id)
      || actor.concentration?.effects?.size;
    if (used) throw new Error(`${actor.name}: лист используется токеном, участником боя, игроком или концентрацией.`);
  }
  const pack = await ensureAuriandriaLibrary({ formSources: actors });
  // Verify both complete stored copies before removing either source.
  for (const actor of actors) {
    const archived = await pack.getDocument(FORM_IDS[formOf(actor)]);
    const expected = actor.toCompendium(pack, { clearFolder: true, clearState: false, clearOwnership: false });
    if (!archived || archived.flags?.[MODULE_ID]?.auriandriaArchivedFrom !== actor.uuid
      || comparable(archived.toObject()) !== comparable(expected)) {
      throw new Error(`${actor.name}: копия в компендиуме отличается от текущего листа. Исходные листы сохранены в мире.`);
    }
  }
  const folders = new Set(actors.map(actor => actor.folder?.id).filter(Boolean));
  await Actor.deleteDocuments(actors.map(actor => actor.id));
  for (const id of folders) {
    const folder = game.folders.get(id);
    if (folder?.name === "Ауриандрия" && !game.actors.some(actor => actor.folder?.id === id)
      && !game.folders.some(child => child.folder?.id === id)) await folder.delete({ deleteContents: false });
  }
  pack.render(true);
  return { pack: pack.collection, moved: actors.map(actor => actor.name) };
}

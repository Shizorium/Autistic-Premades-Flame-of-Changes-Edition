// Optional compatibility check using an existing Foundry installation, without starting its server.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const require = createRequire(`${root}/package.json`);
const peggy = require(`${root}/node_modules/peggy`);
const getProperty = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const deepClone = object => JSON.parse(JSON.stringify(object));
globalThis.deepClone = deepClone;
globalThis.getType = object => typeof object;
globalThis.game = {
  i18n: { format: (key, data) => key + JSON.stringify(data), localize: key => key },
  settings: { get: () => ({}) }, user: { hasPermission: () => false }
};
globalThis.foundry = {
  utils: { deepClone, getProperty, getType, mergeObject: (a, b) => Object.assign(a, b) }, dice: { terms: {} }
};
globalThis.CONFIG = {
  debug: {}, Dice: { randomUniform: Math.random, fulfillment: { defaultMethod: "digital", methods: { digital: {} } } }
};

function load(relative, name) {
  let source = fs.readFileSync(`${root}/client/dice/${relative}`, "utf8").replace(/^import .*?;\r?\n/gm, "");
  source = source.replace(`export default class ${name}`, `globalThis.${name} = class ${name}`);
  vm.runInThisContext(source, { filename: relative });
  return globalThis[name];
}
load("roll.mjs", "Roll");
for (const [file, name] of [
  ["term", "RollTerm"], ["operator", "OperatorTerm"], ["numeric", "NumericTerm"],
  ["dice", "DiceTerm"], ["die", "Die"], ["string", "StringTerm"]
]) foundry.dice.terms[name] = load(`terms/${file}.mjs`, name);
CONFIG.Dice.terms = { d: Die };
CONFIG.Dice.termTypes = foundry.dice.terms;
CONFIG.Dice.rolls = [Roll];
CONFIG.Dice.parser = load("parser.mjs", "RollParser");
foundry.dice.RollGrammar = peggy.generate(fs.readFileSync(`${root}/client/dice/grammar.pegjs`, "utf8"));

for (const dice of ["1d20", "2d20kh", "2d20kl"]) {
  const roll = new Roll(`${dice} + @mod + @apfceExhaustion[Истощение]`, { mod: 3, apfceExhaustion: -5 });
  const penalty = roll.terms.filter(term => term.options.flavor === "Истощение");
  assert.equal(penalty.length, 1);
  assert.equal(penalty[0].number, 5);
  assert.match(roll.formula, /- 5\[Истощение\]/);
  console.log(roll.formula);
}

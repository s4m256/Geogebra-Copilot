import assert from 'node:assert/strict';
import test from 'node:test';
import { executeGeoGebraCommands } from '../src/geogebra.ts';
import { compileSemanticConstruction } from '../src/geometryCompiler.ts';
import { demoConstruction } from '../src/demoConstruction.ts';

test('successful applet intersections preserve geometric dependencies', () => {
  const evaluated = [];
  const commands = compileSemanticConstruction(demoConstruction);
  const result = executeGeoGebraCommands({
    evalCommand(command) { evaluated.push(command); return true; },
    getXcoord() { return 0; }, getYcoord() { return 0; },
  }, commands);
  assert.deepEqual(result.failed, []);
  assert.ok(evaluated.includes('D = Intersect(auxAD, auxBC)'));
  assert.ok(evaluated.includes('H = Intersect(auxAltB, auxAltC)'));
  assert.ok(!evaluated.some(command => /^D = \(/.test(command)), 'altitude foot must not become an independent point');
});

test('rejected perpendicular intersection cannot infer a line from a future point name', () => {
  const commands = compileSemanticConstruction(demoConstruction);
  const evaluated = [];
  const result = executeGeoGebraCommands({
    evalCommand(command) { evaluated.push(command); return !command.startsWith('D ='); },
    getXcoord() { return 0; }, getYcoord() { return 0; },
  }, commands);
  assert.equal(result.failed.length, 1);
  assert.ok(!evaluated.some(command => /^D = \(/.test(command)));
});

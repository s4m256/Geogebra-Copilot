import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSemanticConstruction } from '../src/semanticConstruction.ts';
import { parseConstructionContent } from '../src/ai.ts';
import { compileSemanticConstruction } from '../src/geometryCompiler.ts';
import { demoConstruction } from '../src/demoConstruction.ts';

const points = [
  { type: 'point', name: 'A', x: 0, y: 0 },
  { type: 'point', name: 'B', x: 4, y: 0 },
  { type: 'point', name: 'C', x: 1, y: 3 },
];
const construction = (...objects) => ({ objects: [...points, ...objects] });

for (const [name, value] of [
  ['duplicate object names', construction({ type: 'point', name: 'A', x: 1, y: 1 })],
  ['undefined point', construction({ type: 'midpoint', name: 'M', of: ['A', 'Z'] })],
  ['forward reference', construction({ type: 'midpoint', name: 'M', of: ['A', 'Z'] }, { type: 'point', name: 'Z', x: 2, y: 2 })],
  ['wrong point type', construction({ type: 'line', name: 'L', through: ['A', 'B'] }, { type: 'midpoint', name: 'M', of: ['A', 'L'] })],
  ['wrong circle type', construction({ type: 'line', name: 'L', through: ['A', 'B'] }, { type: 'lineCircleIntersection', name: 'P', line: 'L', circle: 'C', index: 1 })],
  ['ambiguous two-letter line', construction({ type: 'point', name: 'AB', x: 1, y: 1 }, { type: 'altitudeFoot', name: 'D', from: 'C', to: 'AB' })],
  ['repeated vertices', construction({ type: 'orthocenter', name: 'H', triangle: ['A', 'B', 'A'] })],
  ['repeated line endpoints', construction({ type: 'altitudeFoot', name: 'D', from: 'C', to: ['A', 'A'] })],
  ['command injection in a name', construction({ type: 'point', name: 'D);Delete(A)', x: 0, y: 0 })],
  ['extra command field', { objects: points, commands: ['Delete(A)'] }],
]) test(`response boundary rejects ${name} before compilation`, () => {
  const result = parseConstructionContent(JSON.stringify(value));
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
  assert.equal('commands' in result, false);
  assert.throws(() => compileSemanticConstruction(value));
});

test('rejects nonfinite coordinates at the compiler boundary', () => {
  assert.equal(parseSemanticConstruction({ objects: [{type:'point',name:'A',x:Infinity,y:0}] }).ok, false);
});

test('all current constructions pass with correctly typed dependencies', () => {
  const value = construction(
    { type:'polygon',name:'ABC',points:['A','B','C'] },
    { type:'segment',name:'s',from:'A',to:'B' },
    { type:'line',name:'L',through:['A','B'] },
    { type:'line',name:'N',through:['A','C'] },
    { type:'altitudeFoot',name:'D',from:'C',to:'L' },
    { type:'midpoint',name:'M',of:['A','B'] },
    { type:'orthocenter',name:'H',triangle:['A','B','C'] },
    { type:'circleWithDiameter',name:'c',endpoints:['A','B'] },
    { type:'lineIntersection',name:'I',line1:'L',line2:'N' },
    { type:'lineCircleIntersection',name:'P',line:'L',circle:'c',index:1 },
    { type:'reflectAcrossLine',name:'Q',point:'C',line:'L' },
    { type:'altitudeFoot',name:'E',from:'Q',to:'AM' },
  );
  assert.equal(parseConstructionContent(JSON.stringify(value)).ok, true);
});

test('generated helpers do not shadow explicit names defined later', () => {
  const value = construction({ type:'polygon',points:['A','B','C'] }, {type:'midpoint',name:'auxAB',of:['A','B']});
  const commands = compileSemanticConstruction(value);
  assert.ok(commands.includes('auxAB = Midpoint(A, B)'));
  assert.ok(!commands.includes('auxAB = Line(A, B)'));
});

test('two named lines through the same points both exist in output', () => {
  const commands = compileSemanticConstruction(construction(
    {type:'line',name:'L',through:['A','B']},
    {type:'line',name:'N',through:['A','B']},
    {type:'altitudeFoot',name:'D',from:'C',to:'N'},
  ));
  assert.ok(commands.includes('N = Line(A, B)'));
});

test('public example passes the same response boundary', () => {
  const result = parseConstructionContent(JSON.stringify(demoConstruction));
  assert.equal(result.ok, true);
  assert.deepEqual(result.commands, compileSemanticConstruction(demoConstruction));
});

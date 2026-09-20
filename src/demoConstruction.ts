import type { SemanticConstruction } from './geometryCompiler.ts'

export const demoConstruction: SemanticConstruction = { objects: [
  { type: 'point', name: 'A', x: 1, y: 3 },
  { type: 'point', name: 'B', x: 0, y: 0 },
  { type: 'point', name: 'C', x: 5, y: 0 },
  { type: 'polygon', name: 'ABC', points: ['A', 'B', 'C'] },
  { type: 'altitudeFoot', name: 'D', from: 'A', to: ['B', 'C'] },
  { type: 'orthocenter', name: 'H', triangle: ['A', 'B', 'C'] },
] }

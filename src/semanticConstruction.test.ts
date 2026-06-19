import { describe, expect, it } from 'vitest'
import { compileSemanticConstruction } from './geometryCompiler'
import { normalizeGeoGebraBlock } from './lib/ggbCommandNormalizer'
import { parseSemanticConstruction } from './semanticConstruction'

describe('semantic construction schema', () => {
  it('accepts a supported triangle construction', () => {
    const parsed = parseSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 1, y: 2 },
        { type: 'point', name: 'B', x: 0, y: 0 },
        { type: 'point', name: 'C', x: 3, y: 0 },
        { type: 'polygon', name: 'ABC', points: ['A', 'B', 'C'] },
        { type: 'orthocenter', name: 'H', triangle: ['A', 'B', 'C'] },
      ],
    })

    expect(parsed.ok).toBe(true)
  })

  it('rejects references before definition', () => {
    const parsed = parseSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 1, y: 2 },
        { type: 'segment', from: 'A', to: 'B' },
      ],
    })

    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.message).toContain('B')
  })

  it('rejects line references that are neither defined lines nor point pairs', () => {
    const parsed = parseSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 0, y: 0 },
        { type: 'point', name: 'B', x: 2, y: 0 },
        { type: 'pointOnLine', name: 'P', line: 'r' },
      ],
    })

    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.message).toContain('r')
  })
})

describe('geometry compiler regressions', () => {
  it('compiles altitude and orthocenter commands deterministically', () => {
    const commands = compileSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 1, y: 2 },
        { type: 'point', name: 'B', x: 0, y: 0 },
        { type: 'point', name: 'C', x: 3, y: 0 },
        { type: 'polygon', name: 'ABC', points: ['A', 'B', 'C'] },
        { type: 'altitudeFoot', name: 'D', from: 'A', to: ['B', 'C'] },
        { type: 'orthocenter', name: 'H', triangle: ['A', 'B', 'C'] },
      ],
    })

    expect(commands).toContain('D = Intersect(auxAD, auxBC)')
    expect(commands).toContain('H = Intersect(auxAltB, auxAltC)')
  })

  it('compiles new common objects', () => {
    const commands = compileSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 0, y: 2 },
        { type: 'point', name: 'B', x: 0, y: 0 },
        { type: 'point', name: 'C', x: 4, y: 0 },
        { type: 'line', name: 'l', through: ['B', 'C'] },
        { type: 'parallelLine', name: 'p', through: 'A', parallelTo: 'l' },
        { type: 'perpendicularBisector', name: 'm', of: ['A', 'C'] },
        { type: 'angleBisector', name: 'u', angle: ['A', 'B', 'C'] },
        { type: 'circumcenter', name: 'O', triangle: ['A', 'B', 'C'] },
        { type: 'incenter', name: 'I', triangle: ['A', 'B', 'C'] },
      ],
    })

    expect(commands).toEqual(expect.arrayContaining([
      'p = ParallelLine(A, l)',
      'm = PerpendicularBisector(A, C)',
      'u = AngleBisector(A, B, C)',
      'O = Intersect(auxPerpBisAB, m)',
      'I = Intersect(u, auxBisBAC)',
    ]))
  })

  it('compiles circle diameter, line-circle intersection, reflection, and point-on-line', () => {
    const commands = compileSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: -2, y: 0 },
        { type: 'point', name: 'B', x: 2, y: 0 },
        { type: 'point', name: 'C', x: 0, y: 3 },
        { type: 'circleWithDiameter', name: 'c', endpoints: ['A', 'B'] },
        { type: 'line', name: 'l', through: ['A', 'C'] },
        { type: 'lineCircleIntersection', name: 'D', line: 'l', circle: 'c', index: 1 },
        { type: 'reflectAcrossLine', name: 'E', point: 'C', line: ['A', 'B'] },
        { type: 'pointOnLine', name: 'P', line: 'l' },
      ],
    })

    expect(commands).toEqual(expect.arrayContaining([
      'auxMidAB = Midpoint(A, B)',
      'c = Circle(auxMidAB, A)',
      'l = Line(A, C)',
      'D = Intersect(l, c, 1)',
      'auxAB = Line(A, B)',
      'E = Reflect(C, auxAB)',
      'P = Point(l)',
    ]))
  })

  it('keeps dependency order for midpoint, perpendicular, and line intersection constructions', () => {
    const commands = compileSemanticConstruction({
      objects: [
        { type: 'point', name: 'A', x: 0, y: 0 },
        { type: 'point', name: 'B', x: 4, y: 0 },
        { type: 'point', name: 'C', x: 1, y: 3 },
        { type: 'midpoint', name: 'M', of: ['A', 'B'] },
        { type: 'perpendicularLine', name: 'h', through: 'C', to: ['A', 'B'] },
        { type: 'lineIntersection', name: 'D', line1: 'h', line2: ['A', 'B'] },
      ],
    })

    expect(commands).toEqual([
      'A = (0, 0)',
      'B = (4, 0)',
      'C = (1, 3)',
      'M = Midpoint(A, B)',
      'auxAB = Line(A, B)',
      'h = PerpendicularLine(C, auxAB)',
      'D = Intersect(h, auxAB)',
    ])
  })
})

describe('GeoGebra command normalizer', () => {
  it('blocks complex nested commands that cannot be hoisted safely', () => {
    const result = normalizeGeoGebraBlock('A = Intersect(Line(B, C), Circle(D, E)) + 1')

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('complexa')
  })

  it('normalizes supported nested commands', () => {
    const result = normalizeGeoGebraBlock('A = Intersect(Line(B, C), PerpendicularBisector(D, E))')

    expect(result.ok).toBe(true)
    expect(result.commands).toEqual([
      'auxLine1 = Line(B, C)',
      'auxPerpendicularBisector1 = PerpendicularBisector(D, E)',
      'A = Intersect(auxLine1, auxPerpendicularBisector1)',
    ])
  })
})

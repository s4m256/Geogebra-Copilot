import type { GeometryObject, LineReference, SemanticConstruction } from './semanticConstruction'

type CompilerState = {
  commands: string[]
  names: Set<string>
  points: Set<string>
  lines: Map<string, string>
  altitudeLines: Map<string, string>
  parallelLines: Map<string, string>
  perpendicularLines: Map<string, string>
  perpendicularBisectors: Map<string, string>
  angleBisectors: Map<string, string>
}

export function compileSemanticConstruction(construction: SemanticConstruction) {
  const state: CompilerState = {
    commands: [],
    names: new Set(),
    points: new Set(),
    lines: new Map(),
    altitudeLines: new Map(),
    parallelLines: new Map(),
    perpendicularLines: new Map(),
    perpendicularBisectors: new Map(),
    angleBisectors: new Map(),
  }

  for (const object of construction.objects) {
    compileObject(object, state)
  }

  return state.commands
}

function compileObject(object: GeometryObject, state: CompilerState) {
  switch (object.type) {
    case 'point':
      addCommand(state, object.name, `(${formatNumber(object.x)}, ${formatNumber(object.y)})`)
      state.points.add(object.name)
      return

    case 'pointOnLine': {
      const line = ensureLineReference(state, object.line)
      addCommand(state, object.name, `Point(${line})`)
      state.points.add(object.name)
      return
    }

    case 'polygon': {
      const name = object.name ?? `p${object.points.join('')}`
      addCommand(state, name, `Polygon(${object.points.join(', ')})`)

      for (let index = 0; index < object.points.length; index += 1) {
        const from = object.points[index]
        const to = object.points[(index + 1) % object.points.length]
        ensureSegment(state, from, to)
        ensureLine(state, from, to)
      }

      return
    }

    case 'segment':
      ensureSegment(state, object.from, object.to, object.name)
      return

    case 'line':
      ensureLine(state, object.through[0], object.through[1], object.name)
      return

    case 'parallelLine':
      ensureParallelLine(state, object.through, ensureLineReference(state, object.parallelTo), object.name)
      return

    case 'perpendicularLine':
      ensurePerpendicularLine(state, object.through, ensureLineReference(state, object.to), object.name)
      return

    case 'perpendicularBisector':
      ensurePerpendicularBisector(state, object.of[0], object.of[1], object.name)
      return

    case 'angleBisector':
      ensureAngleBisector(state, object.angle[0], object.angle[1], object.angle[2], object.name)
      return

    case 'markedAngle':
      addCommand(state, object.name, `Angle(${object.angle[0]}, ${object.angle[1]}, ${object.angle[2]})`)
      return

    case 'altitudeFoot': {
      const support = ensureLineReference(state, object.to)
      const altitude = ensureAltitudeLine(state, object.from, object.name, support)
      addCommand(state, object.name, `Intersect(${altitude}, ${support})`)
      state.points.add(object.name)
      ensureSegment(state, object.from, object.name)
      return
    }

    case 'midpoint':
      addCommand(state, object.name, `Midpoint(${object.of[0]}, ${object.of[1]})`)
      state.points.add(object.name)
      return

    case 'orthocenter': {
      const [a, b, c] = object.triangle
      const sideAC = ensureLine(state, a, c)
      const sideAB = ensureLine(state, a, b)
      const altitudeFromB = ensureAltitudeLine(state, b, null, sideAC)
      const altitudeFromC = ensureAltitudeLine(state, c, null, sideAB)
      addCommand(state, object.name, `Intersect(${altitudeFromB}, ${altitudeFromC})`)
      state.points.add(object.name)
      return
    }

    case 'circumcenter': {
      const [a, b, c] = object.triangle
      const bisectorAB = ensurePerpendicularBisector(state, a, b)
      const bisectorAC = ensurePerpendicularBisector(state, a, c)
      addCommand(state, object.name, `Intersect(${bisectorAB}, ${bisectorAC})`)
      state.points.add(object.name)
      return
    }

    case 'incenter': {
      const [a, b, c] = object.triangle
      const bisectorABC = ensureAngleBisector(state, a, b, c)
      const bisectorBAC = ensureAngleBisector(state, b, a, c)
      addCommand(state, object.name, `Intersect(${bisectorABC}, ${bisectorBAC})`)
      state.points.add(object.name)
      return
    }

    case 'circleWithDiameter': {
      const center = nextAuxName(state, `auxMid${object.endpoints.join('')}`)
      addCommand(state, center, `Midpoint(${object.endpoints[0]}, ${object.endpoints[1]})`)
      addCommand(state, object.name, `Circle(${center}, ${object.endpoints[0]})`)
      return
    }

    case 'lineIntersection': {
      const line1 = ensureLineReference(state, object.line1)
      const line2 = ensureLineReference(state, object.line2)
      addCommand(state, object.name, `Intersect(${line1}, ${line2})`)
      state.points.add(object.name)
      return
    }

    case 'lineCircleIntersection': {
      const line = ensureLineReference(state, object.line)
      addCommand(state, object.name, `Intersect(${line}, ${object.circle}, ${object.index})`)
      state.points.add(object.name)
      return
    }

    case 'reflectAcrossLine': {
      const line = ensureLineReference(state, object.line)
      addCommand(state, object.name, `Reflect(${object.point}, ${line})`)
      state.points.add(object.name)
      return
    }
  }
}

function ensureParallelLine(
  state: CompilerState,
  through: string,
  line: string,
  preferredName?: string,
) {
  const key = `${through}|${line}`
  const existing = state.parallelLines.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? nextAuxName(state, `auxPar${through}${line}`)
  addCommand(state, name, `ParallelLine(${through}, ${line})`)
  state.parallelLines.set(key, name)
  return name
}

function ensurePerpendicularLine(
  state: CompilerState,
  through: string,
  line: string,
  preferredName?: string,
) {
  const key = `${through}|${line}`
  const existing = state.perpendicularLines.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? nextAuxName(state, `auxPerp${through}${line}`)
  addCommand(state, name, `PerpendicularLine(${through}, ${line})`)
  state.perpendicularLines.set(key, name)
  return name
}

function ensurePerpendicularBisector(
  state: CompilerState,
  from: string,
  to: string,
  preferredName?: string,
) {
  const key = pairKey(from, to)
  const existing = state.perpendicularBisectors.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? nextAuxName(state, `auxPerpBis${from}${to}`)
  addCommand(state, name, `PerpendicularBisector(${from}, ${to})`)
  state.perpendicularBisectors.set(key, name)
  return name
}

function ensureAngleBisector(
  state: CompilerState,
  first: string,
  vertex: string,
  third: string,
  preferredName?: string,
) {
  const key = `${first}|${vertex}|${third}`
  const existing = state.angleBisectors.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? nextAuxName(state, `auxBis${first}${vertex}${third}`)
  addCommand(state, name, `AngleBisector(${first}, ${vertex}, ${third})`)
  state.angleBisectors.set(key, name)
  return name
}

function ensureSegment(state: CompilerState, from: string, to: string, preferredName?: string) {
  const name = preferredName ?? nextVisibleSegmentName(state, from, to)

  if (!state.names.has(name)) {
    addCommand(state, name, `Segment(${from}, ${to})`)
  }

  return name
}

function ensureLineReference(state: CompilerState, reference: LineReference) {
  if (Array.isArray(reference)) {
    return ensureLine(state, reference[0], reference[1])
  }

  const inferredPointPair = inferPointPairFromLineName(state, reference)

  if (inferredPointPair) {
    return ensureLine(state, inferredPointPair[0], inferredPointPair[1])
  }

  return reference
}

function ensureLine(state: CompilerState, from: string, to: string, preferredName?: string) {
  const key = pairKey(from, to)
  const existing = state.lines.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? nextAuxName(state, `aux${from}${to}`)
  addCommand(state, name, `Line(${from}, ${to})`)
  state.lines.set(key, name)
  return name
}

function ensureAltitudeLine(
  state: CompilerState,
  from: string,
  footName: string | null,
  supportLine: string,
) {
  const key = `${from}|${supportLine}`
  const existing = state.altitudeLines.get(key)

  if (existing) {
    return existing
  }

  const name = nextAuxName(state, footName ? `aux${from}${footName}` : `auxAlt${from}`)
  addCommand(state, name, `PerpendicularLine(${from}, ${supportLine})`)
  state.altitudeLines.set(key, name)
  return name
}

function addCommand(state: CompilerState, name: string, expression: string) {
  if (state.names.has(name)) {
    return
  }

  state.commands.push(`${name} = ${expression}`)
  state.names.add(name)
}

function nextVisibleSegmentName(state: CompilerState, from: string, to: string) {
  return nextName(state, `s${from}${to}`)
}

function nextAuxName(state: CompilerState, baseName: string) {
  return nextName(state, sanitizeName(baseName))
}

function nextName(state: CompilerState, baseName: string) {
  let name = sanitizeName(baseName)
  let index = 1

  while (state.names.has(name)) {
    index += 1
    name = `${sanitizeName(baseName)}${index}`
  }

  return name
}

function sanitizeName(name: string) {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, '')
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `aux${sanitized}`
}

function pairKey(first: string, second: string) {
  return [first, second].sort().join('|')
}

function inferPointPairFromLineName(state: CompilerState, reference: string): [string, string] | null {
  if (state.names.has(reference)) {
    return null
  }

  if (reference.length === 2) {
    const first = reference[0]
    const second = reference[1]

    if (state.points.has(first) && state.points.has(second)) {
      return [first, second]
    }
  }

  return null
}

function formatNumber(value: number) {
  return Number(value.toPrecision(12)).toString()
}

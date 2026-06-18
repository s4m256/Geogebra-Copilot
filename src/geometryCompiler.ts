export type SemanticConstruction = {
  objects: GeometryObject[]
}

type LineReference = [string, string] | string

export type GeometryObject =
  | { type: 'point'; name: string; x: number; y: number }
  | { type: 'polygon'; name?: string; points: string[] }
  | { type: 'segment'; name?: string; from: string; to: string }
  | { type: 'line'; name?: string; through: [string, string] }
  | { type: 'altitudeFoot'; name: string; from: string; to: LineReference }
  | { type: 'midpoint'; name: string; of: [string, string] }
  | { type: 'orthocenter'; name: string; triangle: [string, string, string] }
  | { type: 'circleWithDiameter'; name: string; endpoints: [string, string] }
  | { type: 'lineIntersection'; name: string; line1: LineReference; line2: LineReference }
  | { type: 'lineCircleIntersection'; name: string; line: LineReference; circle: string; index: 1 | 2 }
  | { type: 'reflectAcrossLine'; name: string; point: string; line: LineReference }

type CompilerState = {
  commands: string[]
  names: Set<string>
  points: Set<string>
  lines: Map<string, string>
  altitudeLines: Map<string, string>
}

export function compileSemanticConstruction(construction: SemanticConstruction) {
  const state: CompilerState = {
    commands: [],
    names: new Set(),
    points: new Set(),
    lines: new Map(),
    altitudeLines: new Map(),
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

    case 'altitudeFoot': {
      const support = ensureLineReference(state, object.to)
      const altitude = ensureAltitudeLine(state, object.from, object.name, support)
      addCommand(state, object.name, `Intersect(${altitude}, ${support})`)
      ensureSegment(state, object.from, object.name)
      return
    }

    case 'midpoint':
      addCommand(state, object.name, `Midpoint(${object.of[0]}, ${object.of[1]})`)
      return

    case 'orthocenter': {
      const [a, b, c] = object.triangle
      const sideAC = ensureLine(state, a, c)
      const sideAB = ensureLine(state, a, b)
      const altitudeFromB = ensureAltitudeLine(state, b, null, sideAC)
      const altitudeFromC = ensureAltitudeLine(state, c, null, sideAB)
      addCommand(state, object.name, `Intersect(${altitudeFromB}, ${altitudeFromC})`)
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
      return
    }

    case 'lineCircleIntersection': {
      const line = ensureLineReference(state, object.line)
      addCommand(state, object.name, `Intersect(${line}, ${object.circle}, ${object.index})`)
      return
    }

    case 'reflectAcrossLine': {
      const line = ensureLineReference(state, object.line)
      addCommand(state, object.name, `Reflect(${object.point}, ${line})`)
      return
    }
  }
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

export type Point2D = {
  x: number
  y: number
}

export type CoordMap = Record<string, Point2D>

type SegmentMergeAction = {
  createCommand: string | null
  hideNames: string[]
}

type SegmentMergePlan = {
  actions: SegmentMergeAction[]
  warnings: string[]
}

type SegmentCommand = {
  index: number
  raw: string
  name: string | null
  p1: string
  p2: string
}

const COLLINEAR_TOLERANCE = 1e-6
const ZERO_LENGTH_TOLERANCE = 1e-10

export function planCollinearSegmentMerge(
  commands: string[],
  coords: CoordMap,
  existingNames: Set<string>,
): SegmentMergePlan {
  const segments = parseSegments(commands)

  if (segments.length < 2) {
    return { actions: [], warnings: [] }
  }

  const groups = groupCollinear(segments, coords)
  const actions: SegmentMergeAction[] = []
  const warnings: string[] = []
  let mergedNameIndex = 1

  for (const group of groups) {
    if (group.length < 2) {
      continue
    }

    const groupSegments = group.map((index) => segments[index])
    const outerPair = findOutermostPair(groupSegments, coords)

    if (!outerPair) {
      continue
    }

    const existingOuter = groupSegments.find(
      (segment) =>
        segment.name &&
        areSameEndpointPair(segment.p1, segment.p2, outerPair.p1, outerPair.p2),
    )

    const unnamedRedundant = groupSegments.filter((segment) => !segment.name)

    for (const segment of unnamedRedundant) {
      warnings.push(`Cannot hide unnamed redundant segment: ${segment.raw}`)
    }

    if (existingOuter?.name) {
      actions.push({
        createCommand: null,
        hideNames: groupSegments
          .map((segment) => segment.name)
          .filter((name): name is string => Boolean(name) && name !== existingOuter.name),
      })
      continue
    }

    const createName = nextMergedSegmentName(existingNames, mergedNameIndex)
    mergedNameIndex += 1
    existingNames.add(createName)

    actions.push({
      createCommand: `${createName} = Segment(${outerPair.p1}, ${outerPair.p2})`,
      hideNames: groupSegments
        .map((segment) => segment.name)
        .filter((name): name is string => Boolean(name)),
    })
  }

  return { actions, warnings }
}

function parseSegments(commands: string[]) {
  const segments: SegmentCommand[] = []
  const pattern = /^(?:(\w+)\s*=\s*)?Segment\(\s*(\w+)\s*,\s*(\w+)\s*\)$/

  for (const [index, raw] of commands.entries()) {
    const match = raw.trim().match(pattern)

    if (!match) {
      continue
    }

    segments.push({
      index,
      raw,
      name: match[1] ?? null,
      p1: match[2],
      p2: match[3],
    })
  }

  return segments
}

function groupCollinear(segments: SegmentCommand[], coords: CoordMap) {
  const visited = new Array<boolean>(segments.length).fill(false)
  const groups: number[][] = []

  for (let index = 0; index < segments.length; index += 1) {
    if (visited[index]) {
      continue
    }

    const group = [index]
    visited[index] = true

    for (let nextIndex = index + 1; nextIndex < segments.length; nextIndex += 1) {
      if (!visited[nextIndex] && areCollinear(segments[index], segments[nextIndex], coords)) {
        group.push(nextIndex)
        visited[nextIndex] = true
      }
    }

    groups.push(group)
  }

  return groups
}

function areCollinear(a: SegmentCommand, b: SegmentCommand, coords: CoordMap) {
  const a1 = coords[a.p1]
  const a2 = coords[a.p2]
  const b1 = coords[b.p1]
  const b2 = coords[b.p2]

  if (!a1 || !a2 || !b1 || !b2) {
    return false
  }

  const direction = sub(a2, a1)
  const directionLength = length(direction)

  if (directionLength < ZERO_LENGTH_TOLERANCE) {
    return false
  }

  const unitDirection = {
    x: direction.x / directionLength,
    y: direction.y / directionLength,
  }

  return (
    perpendicularDistance(b1, a1, unitDirection) < COLLINEAR_TOLERANCE &&
    perpendicularDistance(b2, a1, unitDirection) < COLLINEAR_TOLERANCE
  )
}

function findOutermostPair(segments: SegmentCommand[], coords: CoordMap) {
  const pointNames = Array.from(
    new Set(segments.flatMap((segment) => [segment.p1, segment.p2])),
  )
  let maxDistance = -1
  let pair: { p1: string; p2: string } | null = null

  for (let leftIndex = 0; leftIndex < pointNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pointNames.length; rightIndex += 1) {
      const leftName = pointNames[leftIndex]
      const rightName = pointNames[rightIndex]
      const left = coords[leftName]
      const right = coords[rightName]

      if (!left || !right) {
        continue
      }

      const currentDistance = distance(left, right)

      if (currentDistance > maxDistance) {
        maxDistance = currentDistance
        pair = { p1: leftName, p2: rightName }
      }
    }
  }

  return pair
}

function nextMergedSegmentName(existingNames: Set<string>, startIndex: number) {
  let index = startIndex
  let name = `mergedSegment${index}`

  while (existingNames.has(name)) {
    index += 1
    name = `mergedSegment${index}`
  }

  return name
}

function areSameEndpointPair(leftA: string, leftB: string, rightA: string, rightB: string) {
  return (
    (leftA === rightA && leftB === rightB) ||
    (leftA === rightB && leftB === rightA)
  )
}

function sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y }
}

function length(vector: Point2D) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y)
}

function distance(a: Point2D, b: Point2D) {
  return length(sub(a, b))
}

function perpendicularDistance(
  point: Point2D,
  lineOrigin: Point2D,
  lineDirection: Point2D,
) {
  const offset = sub(point, lineOrigin)
  const cross = offset.x * lineDirection.y - offset.y * lineDirection.x
  return Math.abs(cross)
}

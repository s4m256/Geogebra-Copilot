import { z, type ZodIssue } from 'zod'

export type SemanticConstruction = {
  objects: GeometryObject[]
}

export type LineReference = [string, string] | string

export type GeometryObject =
  | { type: 'point'; name: string; x: number; y: number }
  | { type: 'pointOnLine'; name: string; line: LineReference }
  | { type: 'polygon'; name?: string; points: string[] }
  | { type: 'segment'; name?: string; from: string; to: string }
  | { type: 'line'; name?: string; through: [string, string] }
  | { type: 'parallelLine'; name: string; through: string; parallelTo: LineReference }
  | { type: 'perpendicularLine'; name: string; through: string; to: LineReference }
  | { type: 'perpendicularBisector'; name: string; of: [string, string] }
  | { type: 'angleBisector'; name: string; angle: [string, string, string] }
  | { type: 'markedAngle'; name: string; angle: [string, string, string] }
  | { type: 'altitudeFoot'; name: string; from: string; to: LineReference }
  | { type: 'midpoint'; name: string; of: [string, string] }
  | { type: 'orthocenter'; name: string; triangle: [string, string, string] }
  | { type: 'circumcenter'; name: string; triangle: [string, string, string] }
  | { type: 'incenter'; name: string; triangle: [string, string, string] }
  | { type: 'circleWithDiameter'; name: string; endpoints: [string, string] }
  | { type: 'lineIntersection'; name: string; line1: LineReference; line2: LineReference }
  | { type: 'lineCircleIntersection'; name: string; line: LineReference; circle: string; index: 1 | 2 }
  | { type: 'reflectAcrossLine'; name: string; point: string; line: LineReference }

type SemanticIssue = {
  path: string
  message: string
}

export type ParsedSemanticConstruction =
  | { ok: true; construction: SemanticConstruction }
  | { ok: false; message: string; issues: SemanticIssue[] }

export const nameSchema = z.string().regex(/^[A-Za-z]\w*$/)
export const pointPairSchema = z.tuple([nameSchema, nameSchema])
export const triangleSchema = z.tuple([nameSchema, nameSchema, nameSchema])
export const lineReferenceSchema = z.union([pointPairSchema, nameSchema])

export const geometryObjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), name: nameSchema, x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('pointOnLine'), name: nameSchema, line: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('polygon'), name: nameSchema.optional(), points: z.array(nameSchema).min(3).max(4) }).strict(),
  z.object({ type: z.literal('segment'), name: nameSchema.optional(), from: nameSchema, to: nameSchema }).strict(),
  z.object({ type: z.literal('line'), name: nameSchema.optional(), through: pointPairSchema }).strict(),
  z.object({ type: z.literal('parallelLine'), name: nameSchema, through: nameSchema, parallelTo: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('perpendicularLine'), name: nameSchema, through: nameSchema, to: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('perpendicularBisector'), name: nameSchema, of: pointPairSchema }).strict(),
  z.object({ type: z.literal('angleBisector'), name: nameSchema, angle: triangleSchema }).strict(),
  z.object({ type: z.literal('markedAngle'), name: nameSchema, angle: triangleSchema }).strict(),
  z.object({ type: z.literal('altitudeFoot'), name: nameSchema, from: nameSchema, to: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('midpoint'), name: nameSchema, of: pointPairSchema }).strict(),
  z.object({ type: z.literal('orthocenter'), name: nameSchema, triangle: triangleSchema }).strict(),
  z.object({ type: z.literal('circumcenter'), name: nameSchema, triangle: triangleSchema }).strict(),
  z.object({ type: z.literal('incenter'), name: nameSchema, triangle: triangleSchema }).strict(),
  z.object({ type: z.literal('circleWithDiameter'), name: nameSchema, endpoints: pointPairSchema }).strict(),
  z.object({ type: z.literal('lineIntersection'), name: nameSchema, line1: lineReferenceSchema, line2: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('lineCircleIntersection'), name: nameSchema, line: lineReferenceSchema, circle: nameSchema, index: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ type: z.literal('reflectAcrossLine'), name: nameSchema, point: nameSchema, line: lineReferenceSchema }).strict(),
])

export const constructionSchema = z.object({
  objects: z.array(geometryObjectSchema).min(1),
}).strict()

export function parseSemanticConstructionContent(content: string): ParsedSemanticConstruction {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(content)
  } catch {
    return {
      ok: false,
      message: 'JSON invalido.',
      issues: [{ path: 'response', message: 'JSON invalido.' }],
    }
  }

  return parseSemanticConstruction(parsedJson)
}

export function parseSemanticConstruction(value: unknown): ParsedSemanticConstruction {
  const parsedConstruction = constructionSchema.safeParse(value)

  if (!parsedConstruction.success) {
    const issues = parsedConstruction.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'response',
      message: formatZodIssue(value, issue),
    }))

    return {
      ok: false,
      message: issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      issues,
    }
  }

  const dependencyIssues = validateSemanticConstruction(parsedConstruction.data)

  if (dependencyIssues.length > 0) {
    return {
      ok: false,
      message: dependencyIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      issues: dependencyIssues,
    }
  }

  return { ok: true, construction: parsedConstruction.data }
}

export function validateSemanticConstruction(construction: SemanticConstruction) {
  const issues: SemanticIssue[] = []
  const knownNames = new Set<string>()
  const knownPoints = new Set<string>()
  const knownLines = new Set<string>()
  const knownCircles = new Set<string>()

  construction.objects.forEach((object, index) => {
    const objectName = readObjectName(object)

    if (objectName && knownNames.has(objectName)) {
      issues.push({
        path: `objects.${index}.name`,
        message: `nome duplicado: ${objectName}.`,
      })
    }

    for (const reference of readNameReferences(object)) {
      if (!knownNames.has(reference)) {
        issues.push({
          path: `objects.${index}`,
          message: `referencia usada antes de ser definida: ${reference}.`,
        })
      }
    }

    for (const lineReference of readLineReferences(object)) {
      validateLineReference(lineReference, knownPoints, knownLines, `objects.${index}`, issues)
    }

    if (object.type === 'lineCircleIntersection' && !knownCircles.has(object.circle)) {
      issues.push({
        path: `objects.${index}.circle`,
        message: `circulo usado antes de ser definido: ${object.circle}.`,
      })
    }

    if (!objectName) {
      return
    }

    knownNames.add(objectName)

    if (isPointProducingObject(object)) {
      knownPoints.add(objectName)
    }

    if (isLineProducingObject(object)) {
      knownLines.add(objectName)
    }

    if (object.type === 'circleWithDiameter') {
      knownCircles.add(objectName)
    }
  })

  return issues
}

function readObjectName(object: GeometryObject) {
  return 'name' in object ? object.name : undefined
}

function readNameReferences(object: GeometryObject) {
  switch (object.type) {
    case 'point':
      return []
    case 'pointOnLine':
      return []
    case 'polygon':
      return object.points
    case 'segment':
      return [object.from, object.to]
    case 'line':
      return object.through
    case 'parallelLine':
      return [object.through]
    case 'perpendicularLine':
      return [object.through]
    case 'perpendicularBisector':
      return object.of
    case 'angleBisector':
    case 'markedAngle':
      return object.angle
    case 'altitudeFoot':
      return [object.from]
    case 'midpoint':
      return object.of
    case 'orthocenter':
    case 'circumcenter':
    case 'incenter':
      return object.triangle
    case 'circleWithDiameter':
      return object.endpoints
    case 'lineIntersection':
      return []
    case 'lineCircleIntersection':
      return []
    case 'reflectAcrossLine':
      return [object.point]
  }
}

function readLineReferences(object: GeometryObject) {
  switch (object.type) {
    case 'pointOnLine':
      return [object.line]
    case 'parallelLine':
      return [object.parallelTo]
    case 'perpendicularLine':
      return [object.to]
    case 'altitudeFoot':
      return [object.to]
    case 'lineIntersection':
      return [object.line1, object.line2]
    case 'lineCircleIntersection':
      return [object.line]
    case 'reflectAcrossLine':
      return [object.line]
    default:
      return []
  }
}

function validateLineReference(
  reference: LineReference,
  knownPoints: Set<string>,
  knownLines: Set<string>,
  path: string,
  issues: SemanticIssue[],
) {
  if (Array.isArray(reference)) {
    for (const point of reference) {
      if (!knownPoints.has(point)) {
        issues.push({ path, message: `ponto de referencia de reta ainda nao definido: ${point}.` })
      }
    }
    return
  }

  if (knownLines.has(reference)) {
    return
  }

  if (reference.length === 2 && knownPoints.has(reference[0]) && knownPoints.has(reference[1])) {
    return
  }

  issues.push({ path, message: `reta ainda nao definida: ${reference}.` })
}

function isPointProducingObject(object: GeometryObject) {
  return [
    'point',
    'pointOnLine',
    'altitudeFoot',
    'midpoint',
    'orthocenter',
    'circumcenter',
    'incenter',
    'lineIntersection',
    'lineCircleIntersection',
    'reflectAcrossLine',
  ].includes(object.type)
}

function isLineProducingObject(object: GeometryObject) {
  return [
    'line',
    'parallelLine',
    'perpendicularLine',
    'perpendicularBisector',
    'angleBisector',
  ].includes(object.type)
}

function formatZodIssue(response: unknown, issue: ZodIssue) {
  const value = readPath(response, issue.path)
  const formattedValue = typeof value === 'string' ? ` (${JSON.stringify(value)})` : ''

  return `${issue.message}${formattedValue}`
}

function readPath(value: unknown, path: Array<PropertyKey>) {
  let current = value

  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }

    current = (current as Record<PropertyKey, unknown>)[key]
  }

  return current
}

import { z, type ZodIssue } from 'zod'
import type { GeometryObject, SemanticConstruction } from './geometryCompiler.ts'
type LineReference = [string, string] | string
type SemanticIssue = { path: string; message: string }
export type ParsedSemanticConstruction =
  | { ok: true; construction: SemanticConstruction }
  | { ok: false; message: string; issues: SemanticIssue[] }

const nameSchema = z.string().regex(/^[A-Za-z]\w*$/)
const pointPairSchema = z.tuple([nameSchema, nameSchema])
const lineReferenceSchema = z.union([pointPairSchema, nameSchema])

const geometryObjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), name: nameSchema, x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('polygon'), name: nameSchema.optional(), points: z.array(nameSchema).min(3).max(4) }).strict(),
  z.object({ type: z.literal('segment'), name: nameSchema.optional(), from: nameSchema, to: nameSchema }).strict(),
  z.object({ type: z.literal('line'), name: nameSchema.optional(), through: pointPairSchema }).strict(),
  z.object({ type: z.literal('altitudeFoot'), name: nameSchema, from: nameSchema, to: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('midpoint'), name: nameSchema, of: pointPairSchema }).strict(),
  z.object({ type: z.literal('orthocenter'), name: nameSchema, triangle: z.tuple([nameSchema, nameSchema, nameSchema]) }).strict(),
  z.object({ type: z.literal('circleWithDiameter'), name: nameSchema, endpoints: pointPairSchema }).strict(),
  z.object({ type: z.literal('lineIntersection'), name: nameSchema, line1: lineReferenceSchema, line2: lineReferenceSchema }).strict(),
  z.object({ type: z.literal('lineCircleIntersection'), name: nameSchema, line: lineReferenceSchema, circle: nameSchema, index: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ type: z.literal('reflectAcrossLine'), name: nameSchema, point: nameSchema, line: lineReferenceSchema }).strict(),
])

const constructionSchema = z.object({
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

    const pointReferences = readNameReferences(object)
    if (new Set(pointReferences).size !== pointReferences.length) {
      issues.push({ path: `objects.${index}`, message: 'pontos de definicao repetidos.' })
    }

    for (const reference of readNameReferences(object)) {
      if (!knownPoints.has(reference)) {
        issues.push({
          path: `objects.${index}`,
          message: `ponto usado antes de ser definido ou com tipo incorreto: ${reference}.`,
        })
      }
    }

    for (const lineReference of readLineReferences(object)) {
      validateLineReference(lineReference, knownNames, knownPoints, knownLines, `objects.${index}`, issues)
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
    case 'polygon':
      return object.points
    case 'segment':
      return [object.from, object.to]
    case 'line':
      return object.through
    case 'altitudeFoot':
      return [object.from]
    case 'midpoint':
      return object.of
    case 'orthocenter':
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
  knownNames: Set<string>,
  knownPoints: Set<string>,
  knownLines: Set<string>,
  path: string,
  issues: SemanticIssue[],
) {
  if (Array.isArray(reference)) {
    if (reference[0] === reference[1]) issues.push({ path, message: 'uma reta precisa de dois pontos distintos.' })
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

  if (!knownNames.has(reference) && reference.length === 2 && reference[0] !== reference[1] && knownPoints.has(reference[0]) && knownPoints.has(reference[1])) {
    return
  }

  issues.push({ path, message: `reta ainda nao definida: ${reference}.` })
}

function isPointProducingObject(object: GeometryObject) {
  return [
    'point',
    'altitudeFoot',
    'midpoint',
    'orthocenter',
    'lineIntersection',
    'lineCircleIntersection',
    'reflectAcrossLine',
  ].includes(object.type)
}

function isLineProducingObject(object: GeometryObject) {
  return [
    'line',
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

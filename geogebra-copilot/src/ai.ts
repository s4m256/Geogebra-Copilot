import { z, type ZodIssue } from 'zod'
import { compileSemanticConstruction, type SemanticConstruction } from './geometryCompiler'
import { SYSTEM_PROMPT } from './systemPrompt'

type GroqMessage = {
  role: 'system' | 'user'
  content: string
}

type GroqResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

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

const GROQ_API_URL =
  import.meta.env.VITE_GROQ_API_URL ??
  'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = import.meta.env.VITE_GROQ_MODEL ?? 'llama-3.3-70b-versatile'
const CACHE_VERSION = 'semantic-v3'
const constructionCache = new Map<string, string[]>()

export async function requestConstruction(prompt: string) {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY

  if (!apiKey) {
    throw new Error('Set VITE_GROQ_API_KEY to enable Copilot generation.')
  }

  const cacheKey = makeCacheKey(prompt)
  const cachedCommands = readCachedCommands(cacheKey)

  if (cachedCommands) {
    return [...cachedCommands]
  }

  const messages: GroqMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]

  const content = await requestChatCompletion(apiKey, messages)
  const parsedConstruction = parseConstructionContent(content)

  if (parsedConstruction.ok) {
    writeCachedCommands(cacheKey, parsedConstruction.commands)
    return [...parsedConstruction.commands]
  }

  const repairContent = await requestChatCompletion(apiKey, [
    ...messages,
    {
      role: 'user',
      content: [
        'Your previous response was invalid.',
        'Return corrected semantic JSON only, with the same construction intent.',
        'The top-level object must have exactly one key: objects.',
        'Do not return GeoGebra command strings.',
        'Use only the supported object types and fields from the system prompt.',
        `Validation error: ${parsedConstruction.message}`,
        `Invalid response: ${content}`,
      ].join('\n'),
    },
  ])
  const repairedConstruction = parseConstructionContent(repairContent)

  if (repairedConstruction.ok) {
    writeCachedCommands(cacheKey, repairedConstruction.commands)
    return [...repairedConstruction.commands]
  }

  throw new Error(`A IA retornou um formato invalido: ${repairedConstruction.message}`)
}

function parseConstructionContent(content: string) {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(content)
  } catch {
    return { ok: false as const, message: 'JSON invalido.' }
  }

  const parsedConstruction = constructionSchema.safeParse(parsedJson)

  if (!parsedConstruction.success) {
    return {
      ok: false as const,
      message: formatSchemaIssues(parsedJson, parsedConstruction.error.issues),
    }
  }

  return {
    ok: true as const,
    commands: compileSemanticConstruction(parsedConstruction.data as SemanticConstruction),
  }
}

async function requestChatCompletion(apiKey: string, messages: GroqMessage[]) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    }),
  })

  const data = (await response.json()) as GroqResponse

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Groq request failed.')
  }

  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('Groq returned an empty response.')
  }

  return content
}

function formatSchemaIssues(response: unknown, issues: ZodIssue[]) {
  return issues
    .map((issue) => {
      const path = issue.path.join('.') || 'response'
      const value = readPath(response, issue.path)
      const formattedValue = typeof value === 'string' ? ` (${JSON.stringify(value)})` : ''

      return `${path}: ${issue.message}${formattedValue}`
    })
    .join('; ')
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

function makeCacheKey(prompt: string) {
  return `${CACHE_VERSION}:${GROQ_MODEL}:${prompt.trim()}`
}

function readCachedCommands(cacheKey: string) {
  const memoryValue = constructionCache.get(cacheKey)

  if (memoryValue) {
    return [...memoryValue]
  }

  try {
    const storedValue = window.localStorage.getItem(cacheKey)

    if (!storedValue) {
      return null
    }

    const parsed = JSON.parse(storedValue)

    if (Array.isArray(parsed) && parsed.every((command) => typeof command === 'string')) {
      constructionCache.set(cacheKey, parsed)
      return [...parsed]
    }
  } catch {
    return null
  }

  return null
}

function writeCachedCommands(cacheKey: string, commands: string[]) {
  constructionCache.set(cacheKey, commands)

  try {
    window.localStorage.setItem(cacheKey, JSON.stringify(commands))
  } catch {
    // Cache persistence is best-effort only.
  }
}

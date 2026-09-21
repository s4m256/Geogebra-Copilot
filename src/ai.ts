import { parseSemanticConstructionContent } from './semanticConstruction.ts'
import { compileSemanticConstruction } from './geometryCompiler.ts'
import { SYSTEM_PROMPT } from './systemPrompt.ts'

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

const GROQ_API_URL =
  import.meta.env?.VITE_GROQ_API_URL ??
  'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = import.meta.env?.VITE_GROQ_MODEL ?? 'llama-3.3-70b-versatile'
const CACHE_VERSION = 'semantic-v4'
const constructionCache = new Map<string, string[]>()

export async function requestConstruction(prompt: string) {
  const apiKey = import.meta.env?.VITE_GROQ_API_KEY

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

export function parseConstructionContent(content: string) {
  const parsed = parseSemanticConstructionContent(content)
  if (!parsed.ok) return parsed
  return { ok: true as const, commands: compileSemanticConstruction(parsed.construction) }
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

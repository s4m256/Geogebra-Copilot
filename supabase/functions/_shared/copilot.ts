import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isProPlan, planFromProfile, type Plan } from './subscription.ts'

type CopilotMode = 'draw' | 'solve'

type ProviderConfig = {
  apiKey: string
  apiUrl: string
  model: string
  plan: Plan
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

type LineReference = [string, string] | string

type GeometryObject =
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

type SemanticConstruction = {
  objects: GeometryObject[]
}

type CompilerState = {
  commands: string[]
  names: Set<string>
  lines: Map<string, string>
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export async function handleCopilotRequest(request: Request) {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const { prompt, mode: rawMode } = await request.json().catch(() => ({ prompt: '' }))
  const mode: CopilotMode = rawMode === 'solve' ? 'solve' : 'draw'

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return jsonResponse({ error: 'Prompt is required.' }, 400)
  }

  const user = await readUser(request)

  if (!user) {
    return jsonResponse({ error: 'Authentication required.' }, 401)
  }

  const plan = await readPlan(user?.id)

  if (mode === 'solve' && !isProPlan(plan)) {
    return jsonResponse({ error: 'O modo Resolver faz parte do plano Pro.' }, 402)
  }

  const usageBeforeRequest = await readUsageToday(user.id)
  const freeDailyLimit = readFreeDailyLimit()

  if (plan === 'free' && usageBeforeRequest >= freeDailyLimit) {
    return jsonResponse({ error: 'Free daily limit reached.' }, 429)
  }

  const config = isProPlan(plan) ? readOpenAiConfig(plan) : readGroqConfig(plan)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(plan, mode) },
    { role: 'user', content: prompt.trim() },
  ]
  let modelContent = await requestChatCompletion(config, messages)
  let parsed = parseModelContent(modelContent, mode)
  let repaired = false

  if (!parsed.ok) {
    const repairContent = await requestChatCompletion(config, [
      ...messages,
      {
        role: 'user',
        content: buildRepairPrompt(parsed.error, modelContent, mode),
      },
    ])

    parsed = parseModelContent(repairContent, mode)
    modelContent = repairContent
    repaired = true
  }

  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 502)
  }

  let commands: string[]

  try {
    commands = parsed.construction ? compileSemanticConstruction(parsed.construction) : []
  } catch (error) {
    if (repaired) {
      return jsonResponse({ error: formatUnknownError(error) }, 502)
    }

    const repairContent = await requestChatCompletion(config, [
      ...messages,
      {
        role: 'user',
        content: buildRepairPrompt(`Compiler error: ${formatUnknownError(error)}`, modelContent, mode),
      },
    ])

    parsed = parseModelContent(repairContent, mode)
    repaired = true

    if (!parsed.ok) {
      return jsonResponse({ error: parsed.error }, 502)
    }

    try {
      commands = parsed.construction ? compileSemanticConstruction(parsed.construction) : []
    } catch (secondError) {
      return jsonResponse({ error: formatUnknownError(secondError) }, 502)
    }
  }

  await recordUsage(user.id, plan)
  const usedToday = usageBeforeRequest + 1

  return jsonResponse({
    commands,
    explanation: parsed.explanation,
    usage: {
      usedToday,
      freeDailyLimit: plan === 'free' ? freeDailyLimit : null,
      remainingToday: plan === 'free' ? Math.max(freeDailyLimit - usedToday, 0) : null,
    },
    debug: {
      provider: 'backend',
      repaired,
      model: config.model,
      plan,
      mode,
    },
  })
}

function readGroqConfig(plan: Plan): ProviderConfig {
  return {
    apiKey: mustReadEnv('GROQ_API_KEY'),
    apiUrl: Deno.env.get('GROQ_API_URL') ?? 'https://api.groq.com/openai/v1/chat/completions',
    model: Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile',
    plan,
  }
}

function readOpenAiConfig(plan: Plan): ProviderConfig {
  return {
    apiKey: mustReadEnv('OPENAI_API_KEY'),
    apiUrl: Deno.env.get('OPENAI_API_URL') ?? 'https://api.openai.com/v1/chat/completions',
    model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4.1',
    plan,
  }
}

async function readUser(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')

  if (!token || !Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return null
  }

  const supabase = createSupabaseAdmin()
  const { data } = await supabase.auth.getUser(token)
  return data.user ?? null
}

async function readPlan(userId: string | undefined): Promise<Plan> {
  if (!userId || !Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return 'free'
  }

  const supabase = createSupabaseAdmin()
  const { data } = await supabase
    .from('profiles')
    .select('plan,is_pro')
    .eq('id', userId)
    .maybeSingle()

  return planFromProfile(data)
}

async function recordUsage(userId: string, plan: Plan) {
  if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return
  }

  const supabase = createSupabaseAdmin()
  await supabase.from('usage_events').insert({ user_id: userId, plan })
}

async function readUsageToday(userId: string) {
  if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return 0
  }

  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)

  const supabase = createSupabaseAdmin()
  const { count } = await supabase
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since.toISOString())

  return count ?? 0
}

function readFreeDailyLimit() {
  const value = Number(Deno.env.get('FREE_DAILY_LIMIT') ?? '50')
  return Number.isFinite(value) && value > 0 ? value : 50
}

function createSupabaseAdmin() {
  return createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
}

async function requestChatCompletion(config: ProviderConfig, messages: ChatMessage[]) {
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: isProPlan(config.plan) ? 2200 : 1200,
      response_format: { type: 'json_object' },
    }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Provider request failed.')
  }

  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('Provider returned an empty response.')
  }

  return content
}

function parseModelContent(content: string, mode: CopilotMode) {
  let parsed: unknown

  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false as const, error: 'Model returned invalid JSON.' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false as const, error: 'Model response was not an object.' }
  }

  const object = parsed as {
    objects?: GeometryObject[]
    construction?: SemanticConstruction | null
    explanation?: unknown
  }
  const construction = object.construction ?? (object.objects ? { objects: object.objects } : null)

  if (construction && !Array.isArray(construction.objects)) {
    return { ok: false as const, error: 'Model response did not include objects.' }
  }

  if (!construction && mode === 'draw') {
    return { ok: false as const, error: 'Model response did not include objects.' }
  }

  if (!construction && typeof object.explanation !== 'string') {
    return { ok: false as const, error: 'Model response did not include explanation or construction.' }
  }

  return {
    ok: true as const,
    construction: construction as SemanticConstruction | null,
    explanation: typeof object.explanation === 'string' ? object.explanation : null,
  }
}

function compileSemanticConstruction(construction: SemanticConstruction) {
  const state: CompilerState = {
    commands: [],
    names: new Set(),
    lines: new Map(),
  }

  for (const object of construction.objects) {
    compileObject(object, state)
  }

  return state.commands
}

function compileObject(object: GeometryObject, state: CompilerState) {
  switch (object.type) {
    case 'point':
      addCommand(state, object.name, `(${object.x}, ${object.y})`)
      return
    case 'pointOnLine':
      addCommand(state, object.name, `Point(${ensureLineReference(state, object.line)})`)
      return
    case 'polygon':
      addCommand(state, object.name ?? `p${object.points.join('')}`, `Polygon(${object.points.join(', ')})`)
      return
    case 'segment':
      addCommand(state, object.name ?? `s${object.from}${object.to}`, `Segment(${object.from}, ${object.to})`)
      return
    case 'line':
      ensureLine(state, object.through[0], object.through[1], object.name)
      return
    case 'parallelLine':
      addCommand(state, object.name, `ParallelLine(${object.through}, ${ensureLineReference(state, object.parallelTo)})`)
      return
    case 'perpendicularLine':
      addCommand(state, object.name, `PerpendicularLine(${object.through}, ${ensureLineReference(state, object.to)})`)
      return
    case 'perpendicularBisector':
      addCommand(state, object.name, `PerpendicularBisector(${object.of[0]}, ${object.of[1]})`)
      return
    case 'angleBisector':
      addCommand(state, object.name, `AngleBisector(${object.angle[0]}, ${object.angle[1]}, ${object.angle[2]})`)
      return
    case 'markedAngle':
      addCommand(state, object.name, `Angle(${object.angle[0]}, ${object.angle[1]}, ${object.angle[2]})`)
      return
    case 'altitudeFoot': {
      const support = ensureLineReference(state, object.to)
      const altitude = `aux${object.from}${object.name}`
      addCommand(state, altitude, `PerpendicularLine(${object.from}, ${support})`)
      addCommand(state, object.name, `Intersect(${altitude}, ${support})`)
      return
    }
    case 'midpoint':
      addCommand(state, object.name, `Midpoint(${object.of[0]}, ${object.of[1]})`)
      return
    case 'orthocenter':
      addCommand(state, object.name, `Orthocenter(${object.triangle.join(', ')})`)
      return
    case 'circumcenter':
      addCommand(state, object.name, `Circumcenter(${object.triangle.join(', ')})`)
      return
    case 'incenter':
      addCommand(state, object.name, `Incenter(${object.triangle.join(', ')})`)
      return
    case 'circleWithDiameter':
      addCommand(state, object.name, `Circle(Midpoint(${object.endpoints[0]}, ${object.endpoints[1]}), ${object.endpoints[0]})`)
      return
    case 'lineIntersection':
      addCommand(state, object.name, `Intersect(${ensureLineReference(state, object.line1)}, ${ensureLineReference(state, object.line2)})`)
      return
    case 'lineCircleIntersection':
      addCommand(state, object.name, `Intersect(${ensureLineReference(state, object.line)}, ${object.circle}, ${object.index})`)
      return
    case 'reflectAcrossLine':
      addCommand(state, object.name, `Reflect(${object.point}, ${ensureLineReference(state, object.line)})`)
      return
  }

  throw new Error(`Unsupported semantic object type: ${(object as { type?: unknown }).type}`)
}

function ensureLineReference(state: CompilerState, reference: LineReference) {
  return Array.isArray(reference) ? ensureLine(state, reference[0], reference[1]) : reference
}

function ensureLine(state: CompilerState, from: string, to: string, preferredName?: string) {
  const key = [from, to].sort().join('|')
  const existing = state.lines.get(key)

  if (existing) {
    return existing
  }

  const name = preferredName ?? `aux${from}${to}`
  addCommand(state, name, `Line(${from}, ${to})`)
  state.lines.set(key, name)
  return name
}

function addCommand(state: CompilerState, name: string, expression: string) {
  if (state.names.has(name)) {
    return
  }

  state.commands.push(`${name} = ${expression}`)
  state.names.add(name)
}

function buildSystemPrompt(plan: Plan, mode: CopilotMode) {
  const base = [
    'Return JSON only.',
    'Use semantic geometry objects, never raw GeoGebra command strings.',
    'Supported object types: point, pointOnLine, polygon, segment, line, parallelLine, perpendicularLine, perpendicularBisector, angleBisector, markedAngle, altitudeFoot, midpoint, orthocenter, circumcenter, incenter, circleWithDiameter, lineIntersection, lineCircleIntersection, reflectAcrossLine.',
    'Names must be ASCII identifiers and every referenced object must be defined earlier.',
  ]

  if (mode === 'solve') {
    return [
      ...base,
      'The user selected Solve mode.',
      'Return { "explanation": "...", "construction": { "objects": [...] } } when a diagram is useful.',
      'If no diagram is useful, return { "explanation": "..." }.',
      'Explain the reasoning in clear Portuguese with concise steps.',
      'Do not include markdown fences or raw GeoGebra commands.',
      isProPlan(plan)
        ? 'Use the stronger model for reasoning and keep the construction semantically valid when included.'
        : 'This mode is unavailable for free users.',
    ].join('\n')
  }

  return [
    ...base,
    'The user selected Draw mode.',
    'Return either { "objects": [...] } or { "explanation": "...", "construction": { "objects": [...] } }.',
    'Focus on producing a reliable construction. Keep explanation short or omit it.',
  ].join('\n')
}

function buildRepairPrompt(error: string, invalidContent: string, mode: CopilotMode) {
  return [
    'Your previous response did not match the required JSON contract.',
    'Return corrected JSON only, preserving the user intent.',
    mode === 'draw'
      ? 'Draw mode requires a construction with a non-empty objects array.'
      : 'Solve mode requires an explanation string and may include a construction with objects.',
    'Do not return markdown, comments, raw GeoGebra commands, or unrelated objects.',
    `Validation error: ${error}`,
    `Invalid response: ${invalidContent}`,
  ].join('\n')
}

function mustReadEnv(name: string) {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`${name} is not configured.`)
  }

  return value
}

function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected compiler error.'
}

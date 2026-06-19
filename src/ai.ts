export type CopilotMode = 'draw' | 'solve'

export type ConstructionResponse = {
  commands: string[]
  explanation: string | null
  debug: {
    provider: 'backend'
    repaired: boolean
    model: string
    plan?: 'free' | 'pro'
    mode?: CopilotMode
  }
}

const FUNCTIONS_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL

type ChatTitleResponse = {
  title?: string
  error?: string
}

export async function requestConstruction(
  input: string,
  options: { accessToken?: string | null; mode?: CopilotMode } = {},
): Promise<ConstructionResponse> {
  const prompt = input.trim()

  if (FUNCTIONS_URL) {
    return requestBackendConstruction(prompt, options.accessToken ?? null, options.mode ?? 'draw')
  }

  throw new Error('Configure VITE_SUPABASE_FUNCTIONS_URL to enable Copilot generation.')
}

export async function requestChatTitle(
  input: string,
  options: { accessToken?: string | null; mode?: CopilotMode } = {},
) {
  const prompt = input.trim()

  if (!FUNCTIONS_URL || !options.accessToken || prompt.length === 0) {
    return fallbackChatTitle(prompt)
  }

  const response = await fetch(`${FUNCTIONS_URL}/chat-title`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify({ prompt, mode: options.mode ?? 'draw' }),
  })
  const data = (await response.json()) as ChatTitleResponse

  if (!response.ok || !data.title) {
    throw new Error(data.error ?? 'Nao foi possivel gerar titulo do chat.')
  }

  return sanitizeChatTitle(data.title, prompt)
}

async function requestBackendConstruction(
  prompt: string,
  accessToken: string | null,
  mode: CopilotMode,
): Promise<ConstructionResponse> {
  const response = await fetch(`${FUNCTIONS_URL}/ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ prompt, mode }),
  })

  const data = (await response.json()) as Partial<ConstructionResponse> & { error?: string }

  if (!response.ok) {
    throw new Error(data.error ?? 'Backend AI request failed.')
  }

  if (!Array.isArray(data.commands)) {
    throw new Error('Backend AI response did not include commands.')
  }

  return {
    commands: data.commands,
    explanation: data.explanation ?? null,
    debug: data.debug ?? { provider: 'backend', repaired: false, model: 'backend' },
  }
}

function fallbackChatTitle(prompt: string) {
  return sanitizeChatTitle(prompt, 'Novo chat')
}

function sanitizeChatTitle(title: string, fallback: string) {
  const cleaned = title
    .replace(/["'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const value = cleaned || fallback || 'Novo chat'
  return value.length > 42 ? `${value.slice(0, 42).trim()}...` : value
}

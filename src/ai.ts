export type CopilotMode = 'draw' | 'solve'

export type ConstructionResponse = {
  commands: string[]
  explanation: string | null
  usage?: {
    usedToday: number
    freeDailyLimit: number | null
    remainingToday: number | null
  }
  debug: {
    provider: 'backend'
    repaired: boolean
    model: string
    plan?: 'free' | 'pro'
    mode?: CopilotMode
  }
}

const FUNCTIONS_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL

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
    usage: data.usage,
    debug: data.debug ?? { provider: 'backend', repaired: false, model: 'backend' },
  }
}

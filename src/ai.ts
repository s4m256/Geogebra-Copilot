export type ConstructionResponse = {
  commands: string[]
  explanation: string | null
  debug: {
    provider: 'backend'
    repaired: boolean
    model: string
    plan?: 'free' | 'pro'
  }
}

const FUNCTIONS_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL

export async function requestConstruction(
  input: string,
  options: { accessToken?: string | null } = {},
): Promise<ConstructionResponse> {
  const prompt = input.trim()

  if (FUNCTIONS_URL) {
    return requestBackendConstruction(prompt, options.accessToken ?? null)
  }

  throw new Error('Configure VITE_SUPABASE_FUNCTIONS_URL to enable Copilot generation.')
}

async function requestBackendConstruction(
  prompt: string,
  accessToken: string | null,
): Promise<ConstructionResponse> {
  const response = await fetch(`${FUNCTIONS_URL}/ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ prompt }),
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

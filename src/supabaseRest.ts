export type Plan = 'free' | 'pro'

export type AuthSession = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  user: {
    id: string
    email: string | null
  }
}

type SupabaseUserResponse = {
  id: string
  email?: string
}

type CheckoutResponse = {
  url?: string
  error?: string
}

type ProfilePlanResponse = {
  plan?: Plan
  is_pro?: boolean
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const FUNCTIONS_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined
const SESSION_STORAGE_KEY = 'ggb-copilot:supabase-session'

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

export function isCheckoutConfigured() {
  return Boolean(FUNCTIONS_URL && isSupabaseConfigured())
}

export function isBackendAiConfigured() {
  return Boolean(FUNCTIONS_URL)
}

export function isProPlan(plan: Plan) {
  return plan === 'pro'
}

export function readStoredSession() {
  try {
    const storedValue = window.localStorage.getItem(SESSION_STORAGE_KEY)

    if (!storedValue) {
      return null
    }

    const parsed = JSON.parse(storedValue) as AuthSession

    if (!parsed.accessToken || !parsed.user?.id) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function storeSession(session: AuthSession) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY)
}

export async function requestMagicLink(email: string) {
  assertSupabaseConfigured()

  const response = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      email,
      create_user: true,
      options: {
        email_redirect_to: window.location.origin,
      },
    }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error_description ?? data.msg ?? 'Nao foi possivel enviar o link de login.')
  }
}

export async function readSessionFromUrl() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const accessToken = hash.get('access_token')

  if (!accessToken) {
    return null
  }

  const refreshToken = hash.get('refresh_token')
  const expiresIn = Number(hash.get('expires_in'))
  const user = await fetchUser(accessToken)
  const session: AuthSession = {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresIn) ? Math.floor(Date.now() / 1000) + expiresIn : null,
    user,
  }

  storeSession(session)
  window.history.replaceState(null, document.title, window.location.pathname + window.location.search)
  return session
}

export async function fetchUser(accessToken: string): Promise<AuthSession['user']> {
  assertSupabaseConfigured()

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: supabaseHeaders(accessToken),
  })

  if (!response.ok) {
    clearStoredSession()
    throw new Error('Sessao expirada. Entre novamente.')
  }

  const data = (await response.json()) as SupabaseUserResponse
  return {
    id: data.id,
    email: data.email ?? null,
  }
}

export async function refreshSession(session: AuthSession) {
  assertSupabaseConfigured()

  if (!session.refreshToken) {
    clearStoredSession()
    return null
  }

  if (!session.expiresAt || session.expiresAt * 1000 > Date.now() + 60_000) {
    return session
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  })

  if (!response.ok) {
    clearStoredSession()
    return null
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    user?: SupabaseUserResponse
  }
  const user = data.user
    ? { id: data.user.id, email: data.user.email ?? null }
    : await fetchUser(data.access_token)
  const nextSession: AuthSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : session.expiresAt,
    user,
  }

  storeSession(nextSession)
  return nextSession
}

export async function fetchPlan(accessToken: string, userId: string): Promise<Plan> {
  assertSupabaseConfigured()

  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,is_pro`, {
    headers: supabaseHeaders(accessToken),
  })

  if (!response.ok) {
    return 'free'
  }

  const rows = (await response.json()) as ProfilePlanResponse[]
  return rows[0]?.is_pro || isProPlan(rows[0]?.plan ?? 'free') ? 'pro' : 'free'
}

export async function signOut(accessToken: string) {
  assertSupabaseConfigured()

  await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: supabaseHeaders(accessToken),
  })
  clearStoredSession()
}

export async function createCheckoutSession(accessToken: string) {
  if (!FUNCTIONS_URL) {
    throw new Error('Configure VITE_SUPABASE_FUNCTIONS_URL para habilitar assinatura.')
  }

  const response = await fetch(`${FUNCTIONS_URL}/create-checkout-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  })
  const data = (await response.json()) as CheckoutResponse

  if (!response.ok || !data.url) {
    throw new Error(data.error ?? 'Nao foi possivel iniciar o checkout.')
  }

  window.location.href = data.url
}

export async function createBillingPortalSession(accessToken: string) {
  if (!FUNCTIONS_URL) {
    throw new Error('Configure VITE_SUPABASE_FUNCTIONS_URL para habilitar cobranca.')
  }

  const response = await fetch(`${FUNCTIONS_URL}/create-billing-portal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  })
  const data = (await response.json()) as CheckoutResponse

  if (!response.ok || !data.url) {
    throw new Error(data.error ?? 'Nao foi possivel abrir o portal de cobranca.')
  }

  window.location.href = data.url
}

function supabaseHeaders(accessToken?: string) {
  assertSupabaseConfigured()
  const anonKey = SUPABASE_ANON_KEY!

  return {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken ?? anonKey}`,
    'Content-Type': 'application/json',
  }
}

function assertSupabaseConfigured() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para habilitar login.')
  }
}

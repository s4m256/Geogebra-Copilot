import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const user = await readUser(request)

  if (!user) {
    return jsonResponse({ error: 'Authentication required.' }, 401)
  }

  const { prompt, mode } = await request.json().catch(() => ({ prompt: '' }))

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return jsonResponse({ error: 'Prompt is required.' }, 400)
  }

  try {
    const title = await generateTitle(prompt, mode === 'solve' ? 'Resolver' : 'Desenhar')
    return jsonResponse({ title })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.'
    return jsonResponse({ error: message }, 500)
  }
})

async function readUser(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')

  if (!token) {
    return null
  }

  const supabase = createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const { data } = await supabase.auth.getUser(token)
  return data.user ?? null
}

async function generateTitle(prompt: string, modeLabel: string) {
  const response = await fetch(Deno.env.get('GROQ_API_URL') ?? 'https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mustReadEnv('GROQ_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: [
            'Voce cria titulos curtos para conversas de geometria.',
            'Responda somente JSON valido: {"title":"..."}',
            'O titulo deve ter 3 a 6 palavras, em portugues, sem ponto final, sem aspas extras e sem emoji.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Modo: ${modeLabel}\nPedido: ${prompt.trim()}`,
        },
      ],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    }),
  })
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Title generation failed.')
  }

  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { title?: unknown }
  return sanitizeTitle(typeof parsed.title === 'string' ? parsed.title : prompt)
}

function sanitizeTitle(title: string) {
  const cleaned = title
    .replace(/["'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) {
    return 'Novo chat'
  }

  return cleaned.length > 42 ? `${cleaned.slice(0, 42).trim()}...` : cleaned
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function mustReadEnv(name: string) {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`${name} is not configured.`)
  }

  return value
}

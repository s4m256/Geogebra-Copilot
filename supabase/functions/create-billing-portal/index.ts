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

  try {
    const user = await readUser(request)

    if (!user) {
      return jsonResponse({ error: 'Authentication required.' }, 401)
    }

    const profile = await readProfile(user.id)

    if (!profile?.stripe_customer_id) {
      return jsonResponse({ error: 'No Stripe customer found.' }, 404)
    }

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mustReadEnv('STRIPE_SECRET_KEY')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: profile.stripe_customer_id,
        return_url: mustReadEnv('STRIPE_PORTAL_RETURN_URL'),
      }),
    })
    const data = await response.json()

    if (!response.ok) {
      return jsonResponse({ error: data.error?.message ?? 'Stripe portal failed.' }, 502)
    }

    return jsonResponse({ url: data.url })
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

  const supabase = createSupabaseAdmin()
  const { data } = await supabase.auth.getUser(token)
  return data.user ?? null
}

async function readProfile(userId: string) {
  const supabase = createSupabaseAdmin()
  const { data } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle()

  return data
}

function createSupabaseAdmin() {
  return createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
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

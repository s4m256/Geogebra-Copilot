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
    const params = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': mustReadEnv('STRIPE_PRO_PRICE_ID'),
      'line_items[0][quantity]': '1',
      success_url: appendCheckoutStatus(mustReadEnv('STRIPE_SUCCESS_URL'), 'success'),
      cancel_url: appendCheckoutStatus(mustReadEnv('STRIPE_CANCEL_URL'), 'cancel'),
      client_reference_id: user.id,
      'metadata[supabase_user_id]': user.id,
      'subscription_data[metadata][supabase_user_id]': user.id,
    })

    if (profile?.stripe_customer_id) {
      params.set('customer', profile.stripe_customer_id)
    } else if (user.email) {
      params.set('customer_email', user.email)
    }

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mustReadEnv('STRIPE_SECRET_KEY')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })

    const data = await response.json()

    if (!response.ok) {
      return jsonResponse({ error: data.error?.message ?? 'Stripe checkout failed.' }, 502)
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

  const supabase = createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const { data } = await supabase.auth.getUser(token)
  return data.user ?? null
}

async function readProfile(userId: string) {
  const supabase = createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const { data } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle()

  return data
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

function appendCheckoutStatus(rawUrl: string, status: 'success' | 'cancel') {
  try {
    const url = new URL(rawUrl)
    url.searchParams.set('checkout', status)
    return url.toString()
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?'
    return `${rawUrl}${separator}checkout=${status}`
  }
}

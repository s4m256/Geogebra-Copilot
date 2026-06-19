import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const payload = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature || !(await verifyStripeSignature(payload, signature))) {
    return new Response('Invalid signature', { status: 400 })
  }

  const event = JSON.parse(payload)
  const stripeObject = event.data?.object
  const supabase = createClient(
    mustReadEnv('SUPABASE_URL'),
    mustReadEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const userId = await readUserId(supabase, stripeObject)

  if (!userId) {
    return new Response('ok')
  }

  const status = readSubscriptionStatus(event.type, stripeObject)
  const plan = status === 'active' || status === 'trialing' ? 'pro' : 'free'

  await supabase.from('profiles').upsert({
    id: userId,
    plan,
    stripe_customer_id: stripeObject.customer,
    stripe_subscription_id: readSubscriptionId(event.type, stripeObject),
    subscription_status: status,
    updated_at: new Date().toISOString(),
  })

  return new Response('ok')
})

async function readUserId(
  supabase: ReturnType<typeof createClient>,
  stripeObject: Record<string, unknown> | undefined,
) {
  const metadataUserId = stripeObject?.metadata?.supabase_user_id

  if (typeof metadataUserId === 'string' && metadataUserId.length > 0) {
    return metadataUserId
  }

  const customerId = stripeObject?.customer

  if (typeof customerId !== 'string' || customerId.length === 0) {
    return null
  }

  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  return typeof data?.id === 'string' ? data.id : null
}

function mustReadEnv(name: string) {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`${name} is not configured.`)
  }

  return value
}

function readSubscriptionStatus(eventType: string, stripeObject: Record<string, unknown>) {
  if (eventType === 'checkout.session.completed') {
    return stripeObject.payment_status === 'paid' || stripeObject.status === 'complete'
      ? 'active'
      : String(stripeObject.status ?? 'incomplete')
  }

  return String(stripeObject.status ?? 'unknown')
}

function readSubscriptionId(eventType: string, stripeObject: Record<string, unknown>) {
  if (eventType === 'checkout.session.completed') {
    return typeof stripeObject.subscription === 'string' ? stripeObject.subscription : null
  }

  return typeof stripeObject.id === 'string' ? stripeObject.id : null
}

async function verifyStripeSignature(payload: string, signature: string) {
  const timestamp = signature
    .split(',')
    .find((part) => part.startsWith('t='))
    ?.slice(2)
  const expected = signature
    .split(',')
    .find((part) => part.startsWith('v1='))
    ?.slice(3)

  if (!timestamp || !expected) {
    return false
  }

  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(mustReadEnv('STRIPE_WEBHOOK_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload),
  )
  const actual = Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return timingSafeEqual(actual, expected)
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false
  }

  let result = 0

  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }

  return result === 0
}

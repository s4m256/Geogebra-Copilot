export type Plan = 'free' | 'pro'

const PRO_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing'])

export function isProPlan(plan: Plan) {
  return plan === 'pro'
}

export function isProSubscriptionStatus(status: string | null | undefined) {
  return Boolean(status && PRO_SUBSCRIPTION_STATUSES.has(status))
}

export function planFromSubscriptionStatus(status: string | null | undefined): Plan {
  return isProSubscriptionStatus(status) ? 'pro' : 'free'
}

export function planFromProfile(profile: { plan?: Plan | null; is_pro?: boolean | null } | null | undefined): Plan {
  if (profile?.is_pro || profile?.plan === 'pro') {
    return 'pro'
  }

  return 'free'
}

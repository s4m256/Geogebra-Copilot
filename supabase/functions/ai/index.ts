import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { handleCopilotRequest, jsonResponse } from '../_shared/copilot.ts'

serve(async (request) => {
  try {
    return await handleCopilotRequest(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.'
    return jsonResponse({ error: message }, 500)
  }
})

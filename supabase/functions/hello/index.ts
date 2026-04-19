// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, message: "hello — POST JSON { \"name\": \"World\" } to personalize" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }

  let name = "World"
  try {
    const body = await req.json()
    if (body && typeof body.name === "string") name = body.name
  } catch {
    // no JSON body
  }

  return new Response(JSON.stringify({ message: `Hello ${name}!` }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
})

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-guest-token",
}

type VisionLine = {
  text: string
  confidence: number | null
}

type VisionAnnotateResponse = {
  responses?: Array<{
    error?: { message?: string }
    fullTextAnnotation?: {
      text?: string
      pages?: Array<{
        blocks?: Array<{
          paragraphs?: Array<{
            confidence?: number
            words?: Array<{
              symbols?: Array<{
                text?: string
                property?: {
                  detectedBreak?: {
                    type?: string
                  }
                }
              }>
            }>
          }>
        }>
      }>
    }
  }>
}

function lineFromParagraph(paragraph: NonNullable<NonNullable<NonNullable<NonNullable<VisionAnnotateResponse["responses"]>[number]["fullTextAnnotation"]>["pages"]>[number]["blocks"]>[number]["paragraphs"][number]): VisionLine | null {
  const text = (paragraph.words ?? [])
    .flatMap((word) => word.symbols ?? [])
    .map((symbol) => `${symbol.text ?? ""}${symbol.property?.detectedBreak?.type === "SPACE" ? " " : ""}`)
    .join("")
    .replace(/\s+/g, " ")
    .trim()

  if (!text) return null
  return {
    text,
    confidence: typeof paragraph.confidence === "number" ? Math.round(paragraph.confidence * 100) : null,
  }
}

function extractLines(annotation: NonNullable<NonNullable<VisionAnnotateResponse["responses"]>[number]["fullTextAnnotation"]>): VisionLine[] {
  const paragraphLines =
    annotation.pages
      ?.flatMap((page) => page.blocks ?? [])
      .flatMap((block) => block.paragraphs ?? [])
      .map(lineFromParagraph)
      .filter((line): line is VisionLine => line !== null) ?? []

  if (paragraphLines.length > 0) {
    return paragraphLines
  }

  return (annotation.text ?? "")
    .split("\n")
    .map((text) => ({ text: text.trim(), confidence: null }))
    .filter((line) => line.text.length > 0)
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY")
    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing GOOGLE_CLOUD_VISION_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const body = await req.json()
    let imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : ""
    const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : ""
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : ""

    if (!imageBase64 && !filePath) {
      return new Response(JSON.stringify({ error: "imageBase64 or filePath is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    let supabaseAdmin: ReturnType<typeof createClient> | null = null

    if (filePath) {
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "sessionId is required when filePath is provided" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
        return new Response(JSON.stringify({ error: "Missing Supabase environment for storage-backed OCR" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      const authHeader = req.headers.get("Authorization") ?? ""
      const supabaseCaller = createClient(supabaseUrl, supabaseAnonKey, {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      })
      const { data: isHost, error: hostError } = await supabaseCaller.rpc("is_session_host", {
        p_session_id: sessionId,
      })
      if (hostError) {
        return new Response(JSON.stringify({ error: hostError.message }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }
      if (!isHost) {
        return new Response(JSON.stringify({ error: "Only the host can OCR a saved receipt." }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey)
      const { data: fileData, error: downloadError } = await supabaseAdmin.storage.from("receipts").download(filePath)
      if (downloadError) {
        return new Response(JSON.stringify({ error: downloadError.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      imageBase64 = encodeBase64(new Uint8Array(await fileData.arrayBuffer()))
    }

    const visionResponse = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: {
              languageHints: ["zh-TW", "zh-Hant", "en"],
            },
          },
        ],
      }),
    })

    const payload = (await visionResponse.json()) as VisionAnnotateResponse
    const response = payload.responses?.[0]
    const upstreamError = response?.error?.message
    if (!visionResponse.ok || upstreamError) {
      return new Response(JSON.stringify({ error: upstreamError ?? "Google Vision OCR failed", payload }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const annotation = response?.fullTextAnnotation
    const lines = annotation ? extractLines(annotation) : []
    let cleanupError: string | null = null

    if (filePath && sessionId && supabaseAdmin) {
      const { error: deleteError } = await supabaseAdmin.storage.from("receipts").remove([filePath])
      if (deleteError) {
        cleanupError = deleteError.message
      } else {
        const { error: clearPathError } = await supabaseAdmin
          .from("sessions")
          .update({ receipt_storage_path: null })
          .eq("id", sessionId)
          .eq("receipt_storage_path", filePath)
        if (clearPathError) {
          cleanupError = clearPathError.message
        }
      }
    }

    return new Response(
      JSON.stringify({
        fullText: annotation?.text ?? "",
        lines,
        cleanupError,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})

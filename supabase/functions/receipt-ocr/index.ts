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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY")
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing GOOGLE_CLOUD_VISION_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const body = await req.json()
    const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : ""

    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "imageBase64 is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
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

    return new Response(
      JSON.stringify({
        fullText: annotation?.text ?? "",
        lines,
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

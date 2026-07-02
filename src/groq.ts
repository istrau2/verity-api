import { config } from "./config";

/**
 * Minimal Groq client. Groq exposes an OpenAI-compatible chat-completions API,
 * so this is a thin fetch wrapper. We ask for a JSON object response and return
 * the raw string content for the caller to parse.
 */
export async function groqChatJSON(system: string, user: string): Promise<string> {
  const res = await fetch(`${config.groqBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: config.groqModel,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

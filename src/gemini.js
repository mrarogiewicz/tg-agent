// Adaptér pre Gemini (záloha). Prevádza spoločný formát (OpenAI messages) na Gemini contents a späť.
// Google Search tu nie je: vo free verzii nie je dostupný.

// Pri prenose konverzácie z iného modelu chýbajú podpisy myšlienok, Gemini 3 vtedy akceptuje túto hodnotu.
const SKIP_SIGNATURE = "skip_thought_signature_validator";

function parseArgs(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

export function toGeminiRequest(messages, tools) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = [];

  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.tool_calls ?? []) {
        parts.push({
          functionCall: { name: c.function.name, args: parseArgs(c.function.arguments) },
          thoughtSignature: c._signature ?? SKIP_SIGNATURE,
        });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      let response = parseArgs(m.content);
      if (Array.isArray(response)) response = { result: response };
      const part = { functionResponse: { name: m.name, response } };
      const last = contents.at(-1);
      // odpovede na viac volaní nástrojov patria do jednej správy
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }

  const request = { contents };
  if (system) request.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) {
    request.tools = [{ functionDeclarations: tools.map((t) => t.function) }];
  }
  return request;
}

export function parseGeminiResponse(response) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: p.functionCall.id ?? `call_${Date.now().toString(36)}_${i}`,
      name: p.functionCall.name,
      args: p.functionCall.args ?? {},
      signature: p.thoughtSignature,
    }));
  return { text, toolCalls };
}

export async function geminiChat(env, model, { messages, tools }, timeoutMs) {
  // Kľúč ide v hlavičke, aby sa nedostal do logov cez URL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
    body: JSON.stringify(toGeminiRequest(messages, tools)),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await r.text();
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${body.slice(0, 300)}`);

  const json = JSON.parse(body);
  if (json.promptFeedback?.blockReason) throw new Error(`Gemini zablokovalo prompt: ${json.promptFeedback.blockReason}`);
  return parseGeminiResponse(json);
}

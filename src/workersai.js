// Adaptér pre Cloudflare Workers AI (binding env.AI). Vstup aj výstup sa prevádzajú na spoločný formát
// (OpenAI messages a tool_calls), takže zvyšok kódu nezávisí od modelu.
import { MAX_OUTPUT_TOKENS } from "./models.js";

function parseArgs(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

// Správy pre model: bez našich pomocných polí (napr. podpisy Gemini).
function toRequestMessages(messages) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: c.function })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, name: m.name, content: m.content };
    return { role: m.role, content: m.content ?? "" };
  });
}

// Modely vracajú buď OpenAI štýl (choices[0].message), Responses štýl (output[]) alebo starší (response, tool_calls).
export function parseWorkersAiResponse(res) {
  const out = res?.result ?? res;
  let text = "";
  let calls = [];

  const msg = out?.choices?.[0]?.message;
  if (msg) {
    text = typeof msg.content === "string" ? msg.content : "";
    calls = (msg.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function?.name ?? c.name,
      args: parseArgs(c.function?.arguments ?? c.arguments),
    }));
  } else if (Array.isArray(out?.output)) {
    for (const item of out.output) {
      if (item.type === "message") {
        text += (item.content ?? []).map((p) => p.text ?? "").join("");
      } else if (item.type === "function_call") {
        calls.push({ id: item.call_id ?? item.id, name: item.name, args: parseArgs(item.arguments) });
      }
    }
  } else {
    text = typeof out?.response === "string" ? out.response : "";
    calls = (out?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function?.name ?? c.name,
      args: parseArgs(c.function?.arguments ?? c.arguments),
    }));
  }

  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  calls = calls.filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  return { text, toolCalls: calls };
}

export async function workersAiChat(env, model, { messages, tools }) {
  const input = { messages: toRequestMessages(messages), max_tokens: MAX_OUTPUT_TOKENS };
  if (tools?.length) input.tools = tools;
  const res = await env.AI.run(model, input);
  return parseWorkersAiResponse(res);
}

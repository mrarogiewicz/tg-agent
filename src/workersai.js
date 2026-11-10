// Adaptér pre Cloudflare Workers AI (binding env.AI). Vstup aj výstup sa prevádzajú na spoločný formát
// (OpenAI messages a tool_calls), takže zvyšok kódu nezávisí od modelu.
import { MAX_OUTPUT_TOKENS, TEMPERATURE } from "./models.js";

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

// gpt-oss občas pošle uvažovanie a odpoveď v jednom texte: "analysis... assistantfinal Odpoveď".
export function cleanText(raw) {
  let text = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const marker = /assistantfinal|<\|channel\|>final<\|message\|>/g;
  let cut = -1;
  for (const m of text.matchAll(marker)) cut = m.index + m[0].length;
  if (cut >= 0) text = text.slice(cut);
  return text.replace(/<\|(?:return|end)\|>\s*$/g, "").trim();
}

// Tokenizácia modelu občas pridá medzery ku kľúčom a hodnotám ({" terms":[" kuracie"]}).
function tidy(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.trim(), tidy(v)]));
  }
  return value;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Najbližší známy nástroj k (rozbitému) názvu, alebo null.
function closestTool(name, toolNames) {
  const ranked = toolNames.map((t) => ({ t, d: distance(name, t) })).sort((x, y) => x.d - y.d);
  if (!ranked.length || ranked[0].d > 3) return null;
  if (ranked[1] && ranked[1].d === ranked[0].d) return null; // nejednoznačné
  return ranked[0].t;
}

// Model niekedy zapíše volanie nástroja ako text ("to=functions.search_off offers {...}<|call|>").
// Ak ide o známy nástroj (aj s rozbitým názvom, napr. s medzerou), volanie z textu vyčítame.
export function recoverLeakedCall(text, toolNames) {
  const m = /to=functions\.([\w .-]+?)\s*(?:<\|constrain\|>\w+\s*)?(\{[\s\S]*\})\s*(?:<\|call\|>|$)/.exec(text ?? "");
  if (!m) return null;
  const name = closestTool(m[1].replace(/\s+/g, ""), toolNames);
  if (!name) return null;
  try {
    return { id: `call_${Date.now().toString(36)}_r`, name, args: tidy(JSON.parse(m[2])) };
  } catch {
    return null;
  }
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

  calls = calls.filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  return { text, toolCalls: calls };
}

export async function workersAiChat(env, model, { messages, tools }) {
  const input = { messages: toRequestMessages(messages), max_tokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE };
  if (tools?.length) input.tools = tools;
  const parsed = parseWorkersAiResponse(await env.AI.run(model, input));

  if (!parsed.toolCalls.length && tools?.length) {
    const recovered = recoverLeakedCall(parsed.text, tools.map((t) => t.function.name));
    if (recovered) return { text: "", toolCalls: [recovered] };
  }
  return { text: cleanText(parsed.text), toolCalls: parsed.toolCalls };
}

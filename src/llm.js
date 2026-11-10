import { CHAIN, GEMINI_TIMEOUT_MS, TOTAL_BUDGET_MS, WORKERS_AI_TIMEOUT_MS } from "./models.js";
import { geminiChat } from "./gemini.js";
import { workersAiChat } from "./workersai.js";

const PROVIDERS = {
  "workers-ai": { available: (env) => Boolean(env.AI), timeoutMs: WORKERS_AI_TIMEOUT_MS, call: workersAiChat },
  gemini: { available: (env) => Boolean(env.GEMINI_KEY), timeoutMs: GEMINI_TIMEOUT_MS, call: geminiChat },
};

export class LlmError extends Error {
  constructor(attempts) {
    super("Žiadny model neodpovedal");
    this.attempts = attempts;
  }
}

export function describeError(err) {
  if (err instanceof LlmError) {
    return `${err.message}. Skúšané modely:\n${err.attempts.map((a) => `- ${a}`).join("\n")}`;
  }
  return `${err?.name || "Error"}: ${err?.message || err}\n${err?.stack || ""}`;
}

// Spoločný časový rozpočet pre všetky volania jednej požiadavky (Cloudflare zruší prácu po odpovedi po 30 s).
export function newDeadline() {
  return Date.now() + TOTAL_BUDGET_MS;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout po ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Vstup: { messages, tools } v OpenAI formáte. Výstup: { text, toolCalls, model }.
export async function chat(env, request, deadline = newDeadline()) {
  const attempts = [];

  for (const { provider, model } of CHAIN) {
    const p = PROVIDERS[provider];
    if (!p?.available(env)) {
      attempts.push(`${model}: nie je nakonfigurovaný`);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining < 1500) {
      attempts.push("vyčerpaný časový rozpočet");
      break;
    }
    const timeoutMs = Math.min(p.timeoutMs, remaining);
    try {
      const reply = await withTimeout(p.call(env, model, request, timeoutMs), timeoutMs);
      if (!reply.text && !reply.toolCalls.length) throw new Error("prázdna odpoveď");
      console.log(`Odpovedal model: ${model}`);
      return { ...reply, model };
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      console.warn(`Model ${model} zlyhal: ${message}`);
      attempts.push(`${model}: ${message}`);
    }
  }
  throw new LlmError(attempts);
}

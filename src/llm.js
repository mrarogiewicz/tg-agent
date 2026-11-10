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

// Interný formát modelu (napr. <|call|>, to=functions.) v odpovedi znamená, že model zlyhal pri volaní nástroja.
const LEAK_RE = /<\|[a-z_]+\|>|to=functions\.|^analysis/i;

// Vstup: { messages, tools } v OpenAI formáte. Výstup: { text, toolCalls, model }.
export async function chat(env, request, deadline = newDeadline()) {
  const attempts = [];

  for (const { provider, model } of CHAIN) {
    const p = PROVIDERS[provider];
    if (!p?.available(env)) {
      attempts.push(`${model}: nie je nakonfigurovaný`);
      continue;
    }

    // Uniknutý formát je náhodný, preto sa ten istý model skúsi ešte raz.
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1500) {
        attempts.push("vyčerpaný časový rozpočet");
        throw new LlmError(attempts);
      }
      const timeoutMs = Math.min(p.timeoutMs, remaining);
      try {
        const reply = await withTimeout(p.call(env, model, request, timeoutMs), timeoutMs);
        if (!reply.text && !reply.toolCalls.length) throw new Error("prázdna odpoveď");
        if (!reply.toolCalls.length && LEAK_RE.test(reply.text)) {
          const leak = new Error(`uniknutý interný formát modelu: ${reply.text.slice(0, 120)}`);
          leak.retry = true;
          throw leak;
        }
        console.log(`Odpovedal model: ${model}`);
        return { ...reply, model };
      } catch (err) {
        const message = String(err?.message || err).slice(0, 300);
        console.warn(`Model ${model} zlyhal (pokus ${attempt + 1}): ${message}`);
        if (err?.retry && attempt === 0 && deadline - Date.now() > 6000) continue;
        attempts.push(`${model}: ${message}`);
        break;
      }
    }
  }
  throw new LlmError(attempts);
}

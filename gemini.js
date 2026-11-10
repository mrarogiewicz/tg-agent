import { MODELS, FALLBACK_STATUSES, ATTEMPT_TIMEOUT_MS, TOTAL_BUDGET_MS } from "./models.js";

export class GeminiError extends Error {
  constructor(model, status, body) {
    super(`Gemini ${status} (${model})`);
    this.model = model;
    this.status = status;
    this.body = body;
  }
}

function geminiHint(status, body) {
  const b = (body || "").toLowerCase();
  if (status === 400 && (b.includes("api key not valid") || b.includes("api_key_invalid")))
    return "Neplatný GEMINI_KEY (skontroluj premennú vo Workeri).";
  if (status === 400) return "Zlý request (skontroluj prompt/parametre).";
  if (status === 401) return "Chýba alebo je neplatný API kľúč.";
  if (status === 403) return "Kľúč nemá oprávnenie / API je zakázané / región nepodporovaný.";
  if (status === 404) return "Model neexistuje alebo nie je dostupný pre tento kľúč.";
  if (status === 429) return "Vyčerpaná kvóta / rate limit Gemini.";
  if (status >= 500) return "Gemini má problém na strane Googlu (skús neskôr).";
  return "Neznáma chyba Gemini.";
}

export function describeError(err) {
  if (err instanceof GeminiError) {
    return `GEMINI ${err.status} (model: ${err.model}, vyskúšané modely: ${MODELS.length})\n${geminiHint(
      err.status,
      err.body
    )}\n\nOdpoveď API:\n${err.body}`;
  }
  return `${err?.name || "Error"}: ${err?.message || err}\n${err?.stack || ""}`;
}

// Jedno volanie jedného modelu. `request` je telo generateContent (contents, tools, systemInstruction...).
async function callOnce(env, model, request, timeoutMs) {
  // Kľúč ide v hlavičke, aby sa nedostal do logov cez URL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseText = await r.text();
  console.log(`Gemini [${model}] HTTP status:`, r.status);
  if (!r.ok) {
    console.error(`Gemini [${model}] chyba:`, r.status, responseText);
    throw new GeminiError(model, r.status, responseText);
  }

  const j = JSON.parse(responseText);
  const blockReason = j.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini [${model}] zablokovalo prompt: ${blockReason}`);
  return j;
}

// Spoločný časový rozpočet pre všetky volania jednej požiadavky (Cloudflare zruší prácu po odpovedi po 30 s).
export function newDeadline() {
  return Date.now() + TOTAL_BUDGET_MS;
}

// Skúša modely v poradí z models.js. Ak zlyhajú všetky, vyhodí poslednú chybu.
export async function generate(env, request, deadline = newDeadline()) {
  let lastError;
  let tried = 0;

  for (const model of MODELS) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) {
      console.warn("Vyčerpaný časový rozpočet, ďalšie volania sa už nerobia.");
      break;
    }
    tried++;
    try {
      const out = await callOnce(env, model, request, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
      console.log(`Odpovedal model: ${model}`);
      return out;
    } catch (err) {
      const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
      // message vo výnimke TimeoutError je read-only, preto vytvárame novú chybu
      lastError = isTimeout ? new Error(`Model ${model} neodpovedal včas (timeout)`) : err;
      const retryable = err instanceof GeminiError && FALLBACK_STATUSES.includes(err.status);
      const networkFail = !(err instanceof GeminiError) && err instanceof TypeError; // fetch zlyhal
      if (retryable || networkFail || isTimeout) {
        console.warn(`Model ${model} zlyhal (${err.status ?? err.message}), skúšam ďalší.`);
        continue;
      }
      throw err; // zlý kľúč, zlý request... ďalší model by nepomohol
    }
  }

  if (lastError && !(lastError instanceof GeminiError)) {
    throw new Error(`${lastError.message}\n(vyskúšaných modelov: ${tried} z ${MODELS.length})`);
  }
  throw lastError || new Error("Žiadny model sa nestihol vyskúšať (vyčerpaný časový rozpočet).");
}

export function textOf(response) {
  return (response.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

// Jednoduché volanie "prompt -> text", voliteľne s Google Search.
export async function geminiText(env, prompt, { search = false, deadline } = {}) {
  const request = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (search) request.tools = [{ google_search: {} }];
  const response = await generate(env, request, deadline);
  const out = textOf(response);
  if (!out) {
    const finish = response.candidates?.[0]?.finishReason;
    throw new Error(`Prázdna odpoveď Gemini (finishReason: ${finish || "?"})`);
  }
  return out;
}

// Poradie modelov: skúšajú sa od prvého, kým jeden neodpovie. Poskytovateľ bez konfigurácie sa preskočí.
// workers-ai = Cloudflare (binding AI, zadarmo 10 000 neurónov denne), gemini = záloha (len text a nástroje, bez web searchu).
// gpt-oss-120b občas zapíše volanie nástroja ako text, preto je až druhý.
export const CHAIN = [
  { provider: "workers-ai", model: "@cf/qwen/qwen3-30b-a3b-fp8" },
  { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
  { provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash" },
  { provider: "gemini", model: "gemini-3.1-flash-lite" },
];

// Cloudflare zruší spracovanie po odpovedi po 30 s, preto celý reťazec musí skončiť skôr.
export const WORKERS_AI_TIMEOUT_MS = 15000; // max. čas jedného modelu v Cloudflare
export const GEMINI_TIMEOUT_MS = 25000;
export const TOTAL_BUDGET_MS = 26000; // max. čas všetkých pokusov spolu

// Reasoning modely míňajú tokeny aj na uvažovanie, predvolených 256 by odpoveď orezalo.
export const MAX_OUTPUT_TOKENS = 1500;

// Nižšia náhodnosť = spoľahlivejšie volanie nástrojov.
export const TEMPERATURE = 0.2;

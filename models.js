// Poradie modelov: skúšajú sa od prvého po posledný, kým jeden neodpovie.
export const MODELS = [
  "gemini-3.1-flash-lite",
];

// Pri týchto HTTP statusoch sa skúsi ďalší model.
// 400/401/403 sa nepokúšajú znova (zlý request alebo kľúč, ďalší model by zlyhal rovnako).
export const FALLBACK_STATUSES = [404, 429, 500, 502, 503, 504];

// Cloudflare zruší spracovanie po odpovedi po 30 s, preto celý reťazec musí skončiť skôr.
export const ATTEMPT_TIMEOUT_MS = 25000; // max. čas jedného modelu
export const TOTAL_BUDGET_MS = 26000; // max. čas všetkých pokusov spolu

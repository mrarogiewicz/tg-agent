// Poradie modelov: skúšajú sa od prvého po posledný, kým jeden neodpovie.
export const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.8-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

// Pri týchto HTTP statusoch sa skúsi ďalší model.
// 400/401/403 sa nepokúšajú znova (zlý request alebo kľúč, ďalší model by zlyhal rovnako).
export const FALLBACK_STATUSES = [404, 429, 500, 502, 503, 504];

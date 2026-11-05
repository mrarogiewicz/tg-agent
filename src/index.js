const TZ = "Europe/Bratislava";
const MODEL = "gemini-3.8-flash";
const REQUIRED_ENV = ["SECRET", "OWNER_ID", "TG_TOKEN", "GEMINI_KEY"];

export default {
  // Správa z Telegramu (webhook)
  async fetch(req, env, ctx) {
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (!env.KV) missing.push("KV (binding)");
    if (missing.length) {
      console.error("CHÝBAJÚ PREMENNÉ vo Workeri:", missing.join(", "));
      return new Response("ok");
    }

    const secretHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.SECRET) {
      console.error(
        secretHeader
          ? "403: X-Telegram-Bot-Api-Secret-Token sa nezhoduje s env.SECRET (webhook bol nastavený s iným secret_token)"
          : "403: Telegram neposlal secret header (webhook nebol nastavený so secret_token)"
      );
      return new Response("no", { status: 403 });
    }

    let data;
    try {
      data = await req.json();
    } catch (e) {
      console.error("Neplatný JSON z Telegramu:", e.message);
      return new Response("ok");
    }

    const m = data.message;
    if (!m?.text) return new Response("ok");

    if (String(m.from.id) !== String(env.OWNER_ID)) {
      console.log(`Správa od cudzieho ID ${m.from.id}, očakávané ${env.OWNER_ID}`);
      return new Response("ok");
    }

    ctx.waitUntil(safeHandle(m.text, env));
    return new Response("ok");
  },

  // Spúšťa sa každú minútu (cron)
  async scheduled(_e, env, ctx) {
    ctx.waitUntil(
      runDue(env).catch(async (err) => {
        console.error("Chyba v runDue:", err);
        await send(env, `❌ Chyba v naplánovanej úlohe:\n${describeError(err)}`);
      })
    );
  },
};

// ---------- Chyby ----------

class GeminiError extends Error {
  constructor(status, body) {
    super(`Gemini ${status}`);
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
  if (status === 404) return `Model "${MODEL}" neexistuje alebo nie je dostupný pre tento kľúč.`;
  if (status === 429) return "Vyčerpaná kvóta / rate limit Gemini.";
  if (status >= 500) return "Gemini má problém na strane Googlu (skús neskôr).";
  return "Neznáma chyba Gemini.";
}

function describeError(err) {
  if (err instanceof GeminiError) {
    return `GEMINI ${err.status}\n${geminiHint(err.status, err.body)}\n\nOdpoveď API:\n${err.body}`;
  }
  return `${err?.name || "Error"}: ${err?.message || err}\n${err?.stack || ""}`;
}

// ---------- Gemini ----------

async function gemini(env, prompt, { json = false, search = false } = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: json ? { responseMimeType: "application/json" } : {},
  };
  if (search) body.tools = [{ google_search: {} }];

  // Kľúč ide v hlavičke, aby sa nedostal do logov cez URL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
    body: JSON.stringify(body),
  });

  const responseText = await r.text();
  console.log("Gemini HTTP status:", r.status);

  if (!r.ok) {
    console.error("Gemini chyba:", r.status, responseText);
    throw new GeminiError(r.status, responseText);
  }

  const j = JSON.parse(responseText);
  const blockReason = j.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini zablokovalo prompt: ${blockReason}`);

  const textOut = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!textOut) {
    const finish = j.candidates?.[0]?.finishReason;
    throw new Error(`Prázdna odpoveď Gemini (finishReason: ${finish || "?"})\n${responseText.slice(0, 1500)}`);
  }
  return textOut;
}

// ---------- Telegram ----------

async function send(env, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_ID, text: String(text).slice(0, 4000) }),
    });
    if (!r.ok) console.error("Telegram sendMessage chyba:", r.status, await r.text());
  } catch (e) {
    console.error("Telegram send výnimka:", e.message);
  }
}

// ---------- Logika ----------

async function safeHandle(text, env) {
  try {
    await handle(text, env);
  } catch (err) {
    console.error("Chyba v handle():", err);
    await send(env, `❌ Chyba:\n${describeError(err)}`);
  }
}

async function handle(text, env) {
  const tasks = JSON.parse((await env.KV.get("tasks")) || "[]");

  const promptText = `Si osobny asistent. Sprava pouzivatela: "${text}"
Existujuce ulohy: ${JSON.stringify(tasks)}
Vrat JSON: {"action":"add|list|delete|chat","time":"HH:MM","days":"daily|weekdays","prompt":"co ma asistent urobit pri kazdom spusteni","id":"id ulohy na zmazanie","reply":"kratka odpoved po slovensky"}`;

  const raw = await gemini(env, promptText, { json: true });

  let intent;
  try {
    intent = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Neplatný JSON od AI: ${e.message}\nOdpoveď AI:\n${raw}`);
  }

  if (intent.action === "add") {
    tasks.push({ id: Date.now().toString(36), time: intent.time, days: intent.days, prompt: intent.prompt });
    await env.KV.put("tasks", JSON.stringify(tasks));
    return send(env, `Hotovo: ${intent.days} o ${intent.time} - ${intent.prompt}`);
  }
  if (intent.action === "list") {
    return send(
      env,
      tasks.length ? tasks.map((t) => `${t.id}: ${t.days} ${t.time} - ${t.prompt}`).join("\n") : "Ziadne ulohy."
    );
  }
  if (intent.action === "delete") {
    const next = tasks.filter((t) => t.id !== intent.id);
    await env.KV.put("tasks", JSON.stringify(next));
    return send(env, next.length === tasks.length ? "Úloha s takým ID neexistuje." : "Zmazane.");
  }

  const chatResponse = await gemini(env, text, { search: true });
  return send(env, chatResponse);
}

async function runDue(env) {
  const tasks = JSON.parse((await env.KV.get("tasks")) || "[]");
  if (!tasks.length) return;
  const now = new Date();
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" }).format(now);
  const weekend = wd === "Sat" || wd === "Sun";
  for (const t of tasks) {
    if (t.time !== hm || (t.days === "weekdays" && weekend)) continue;
    try {
      const out = await gemini(env, `${t.prompt}\nOdpovedz strucne po slovensky.`, { search: true });
      await send(env, out);
    } catch (err) {
      console.error(`Úloha ${t.id} zlyhala:`, err);
      await send(env, `❌ Úloha ${t.id} (${t.prompt}) zlyhala:\n${describeError(err)}`);
    }
  }
}

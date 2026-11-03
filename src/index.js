const TZ = "Europe/Bratislava";
const MODEL = "gemini-3.8-flash";

export default {
  // Správa z Telegramu (webhook)
  async fetch(req, env, ctx) {
    console.log("=== NOVÝ REQUEST Z TELEGRAMU ===");
    
    const secretHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    console.log("Prijatý Secret Header:", secretHeader ? "nastavený" : "chybí");

    if (secretHeader !== env.SECRET) {
      console.error("CHYBA: Nesedí X-Telegram-Bot-Api-Secret-Token!");
      return new Response("no", { status: 403 });
    }

    const data = await req.json();
    console.log("Celý JSON payload z Telegramu:", JSON.stringify(data));

    const m = data.message;
    if (!m?.text) {
      console.log("Správa neobsahuje text, končím.");
      return new Response("ok");
    }

    console.log(`ID odosielateľa: ${m.from.id}, Očakávaný OWNER_ID: ${env.OWNER_ID}`);
    if (String(m.from.id) !== env.OWNER_ID) {
      console.log("CHYBA: Správa nie je od vlastníka (nesedí OWNER_ID)!");
      return new Response("ok");
    }

    ctx.waitUntil(handle(m.text, env));
    return new Response("ok");
  },

  // Spúšťa sa každú minútu (cron)
  async scheduled(_e, env, ctx) {
    ctx.waitUntil(runDue(env));
  },
};

async function gemini(env, prompt, { json = false, search = false } = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: json ? { responseMimeType: "application/json" } : {},
  };
  if (search) body.tools = [{ google_search: {} }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_KEY}`;
  console.log("Volám Gemini API na URL:", url);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const responseText = await r.text();
    console.log("Gemini HTTP status:", r.status);
    console.log("Gemini surová odpoveď:", responseText);

    if (!r.ok) {
      console.error(`Gemini API vrátilo chybu ${r.status}:`, responseText);
      return `Chyba Gemini (${r.status}): ${responseText}`;
    }

    const j = JSON.parse(responseText);
    const textOut = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
    console.log("Úspešne vygenerovaný text od Gemini:", textOut);
    return textOut || "Prazdna odpoved Gemini.";
  } catch (err) {
    console.error("Výnimka vo funkcii gemini():", err.message);
    return `Chyba v gemini(): ${err.message}`;
  }
}

async function send(env, text) {
  console.log("Odosielam správu do Telegramu, dĺžka textu:", text.length);
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.OWNER_ID, text: text.slice(0, 4000) }),
  });
  const resText = await r.text();
  console.log("Telegram send HTTP status:", r.status, "Odpoveď:", resText);
}

async function handle(text, env) {
  console.log("Spracovávam text v handle():", text);
  
  let tasks = [];
  try {
    tasks = JSON.parse((await env.KV.get("tasks")) || "[]");
    console.log("Načítané úlohy z KV:", tasks.length);
  } catch (e) {
    console.error("Chyba pri čítaní KV storage:", e.message);
  }

  const promptText = `Si osobny asistent. Sprava pouzivatela: "${text}"
Existujuce ulohy: ${JSON.stringify(tasks)}
Vrat JSON: {"action":"add|list|delete|chat","time":"HH:MM","days":"daily|weekdays","prompt":"co ma asistent urobit pri kazdom spusteni","id":"id ulohy na zmazanie","reply":"kratka odpoved po slovensky"}`;

  const geminiResp = await gemini(env, promptText, { json: true });

  if (geminiResp.startsWith("Chyba Gemini")) {
    console.error("Gemini zlyhalo, posielam chybu do Telegramu.");
    return send(env, geminiResp);
  }

  let intent;
  try {
    intent = JSON.parse(geminiResp);
    console.log("Úspešne spárovaný intent JSON:", intent);
  } catch (e) {
    console.error("Chyba parsovania JSON od Gemini:", e.message, "Odpoveď bola:", geminiResp);
    return send(env, `Chyba parsovania JSON: ${e.message}\nOdpoveď AI bola:\n${geminiResp}`);
  }

  if (intent.action === "add") {
    tasks.push({ id: Date.now().toString(36), time: intent.time, days: intent.days, prompt: intent.prompt });
    await env.KV.put("tasks", JSON.stringify(tasks));
    console.log("Úloha pridaná do KV.");
    return send(env, `Hotovo: ${intent.days} o ${intent.time} - ${intent.prompt}`);
  }
  if (intent.action === "list") {
    console.log("Vypisujem zoznam úloh.");
    return send(
      env,
      tasks.length ? tasks.map((t) => `${t.id}: ${t.days} ${t.time} - ${t.prompt}`).join("\n") : "Ziadne ulohy."
    );
  }
  if (intent.action === "delete") {
    tasks = tasks.filter((t) => t.id !== intent.id);
    await env.KV.put("tasks", JSON.stringify(tasks));
    console.log("Úloha zmazaná z KV.");
    return send(env, "Zmazane.");
  }
  
  console.log("Akcia je 'chat', volám Gemini pre všeobecnú odpoveď.");
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
    const out = await gemini(env, `${t.prompt}\nOdpovedz strucne po slovensky.`, { search: true });
    await send(env, out);
  }
}

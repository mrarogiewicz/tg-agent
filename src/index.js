const TZ = "Europe/Bratislava";
const MODEL = "gemini-3.8-flash";


export default {
  // Sprava z Telegramu (webhook)
  async fetch(req, env, ctx) {
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET)
      return new Response("no", { status: 403 });
    const m = (await req.json()).message;
    if (!m?.text || String(m.from.id) !== env.OWNER_ID) return new Response("ok");
    ctx.waitUntil(handle(m.text, env));
    return new Response("ok");
  },
  // Spusta sa kazdu minutu (cron)
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
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await r.json();
  if (!r.ok) return `Chyba Gemini (${r.status}): ${j.error?.message ?? "neznama"}`;
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "Prazdna odpoved Gemini.";
}

async function send(env, text) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.OWNER_ID, text: text.slice(0, 4000) }),
  });
}

async function handle(text, env) {
  const tasks = JSON.parse((await env.KV.get("tasks")) || "[]");
  let intent;
  
  // ZMENA TU: Zachytíme presnú chybovú hlášku z funkcie gemini()
  const geminiResponse = await gemini(
    env,
    `Si osobny asistent. Sprava pouzivatela: "${text}"
Existujuce ulohy: ${JSON.stringify(tasks)}
Vrat JSON: {"action":"add|list|delete|chat","time":"HH:MM","days":"daily|weekdays","prompt":"co ma asistent urobit pri kazdom spusteni","id":"id ulohy na zmazanie","reply":"kratka odpoved po slovensky"}`,
    { json: true }
  );

  // Ak gemini() vrátilo reťazec začínajúci na "Chyba Gemini", pošleme ju priamo používateľovi
  if (geminiResponse.startsWith("Chyba Gemini")) {
    return send(env, geminiResponse);
  }

  try {
    intent = JSON.parse(geminiResponse);
  } catch (e) {
    // Tu sa zobrazí detailná chyba parsovania JSON-u aj s odpoveďou, ktorú AI poslala
    return send(env, `Chyba spracovania JSON: ${e.message}\nOdpoveď AI bola: ${geminiResponse}`);
  }

  if (intent.action === "add") {
    tasks.push({ id: Date.now().toString(36), time: intent.time, days: intent.days, prompt: intent.prompt });
    await env.KV.put("tasks", JSON.stringify(tasks));
    return send(env, `Hotovo: ${intent.days} o ${intent.time} - ${intent.prompt}`);
  }
  if (intent.action === "list")
    return send(
      env,
      tasks.length ? tasks.map((t) => `${t.id}: ${t.days} ${t.time} - ${t.prompt}`).join("\n") : "Ziadne ulohy."
    );
  if (intent.action === "delete") {
    await env.KV.put("tasks", JSON.stringify(tasks.filter((t) => t.id !== intent.id)));
    return send(env, "Zmazane.");
  }
  return send(env, await gemini(env, text, { search: true }));
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

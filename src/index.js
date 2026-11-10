import { runAgent } from "./agent.js";
import { withDb } from "./d1rest.js";
import { describeError } from "./gemini.js";
import { TZ } from "./util.js";

const REQUIRED_ENV = ["SECRET", "OWNER_ID", "TG_TOKEN", "GEMINI_KEY"];
const HISTORY_KEY = "history";
const HISTORY_MAX_MESSAGES = 8; // posledné 4 výmeny, aby sa dalo nadviazať ("a v Lidli?")
const HISTORY_TTL_SECONDS = 2 * 60 * 60;

export default {
  // Správa z Telegramu (webhook)
  async fetch(req, rawEnv, ctx) {
    const missing = REQUIRED_ENV.filter((k) => !rawEnv[k]);
    if (!rawEnv.KV) missing.push("KV (binding)");
    const { env, missing: missingDb } = withDb(rawEnv);
    missing.push(...missingDb);
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
  async scheduled(_e, rawEnv, ctx) {
    const { env } = withDb(rawEnv);
    ctx.waitUntil(
      runDue(env).catch(async (err) => {
        console.error("Chyba v runDue:", err);
        await send(env, `❌ Chyba v naplánovanej úlohe:\n${describeError(err)}`);
      })
    );
  },
};

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

// ---------- História konverzácie ----------

async function loadHistory(env) {
  const items = JSON.parse((await env.KV.get(HISTORY_KEY)) || "[]");
  return Array.isArray(items) ? items : [];
}

async function saveHistory(env, items) {
  const trimmed = items.slice(-HISTORY_MAX_MESSAGES);
  // história musí začínať správou používateľa
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  await env.KV.put(HISTORY_KEY, JSON.stringify(trimmed), { expirationTtl: HISTORY_TTL_SECONDS });
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
  const command = text.trim().toLowerCase();
  if (command === "/reset") {
    await env.KV.delete(HISTORY_KEY);
    return send(env, "Konverzácia vymazaná.");
  }
  if (command === "/start") {
    return send(
      env,
      "Ahoj! Pýtaj sa na ceny a akcie z letákov Lidl a Kaufland, napr.:\n" +
        "• kde je najlacnejšie kuracie?\n" +
        "• čo je tento týždeň v akcii z mäsa a čo z toho navarím?\n" +
        "• kde nakúpim na guláš pre 4?\n" +
        "• pridaj do mojich potravín mlieko, vajcia, maslo\n" +
        "• čo sa mi tento týždeň oplatí kúpiť?\n" +
        "/reset vymaže kontext rozhovoru."
    );
  }

  const history = await loadHistory(env);
  const answer = await runAgent(env, text, { history });
  await send(env, answer);
  await saveHistory(env, [...history, { role: "user", text }, { role: "model", text: answer }]);
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
      const out = await runAgent(env, `${t.prompt}\nOdpovedz strucne po slovensky.`);
      await send(env, out);
    } catch (err) {
      console.error(`Úloha ${t.id} zlyhala:`, err);
      await send(env, `❌ Úloha ${t.id} (${t.prompt}) zlyhala:\n${describeError(err)}`);
    }
  }
}

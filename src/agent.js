import { chat, newDeadline } from "./llm.js";
import { declarations, runTool } from "./tools/index.js";
import { todayISO, weekdayName } from "./util.js";

const MAX_STEPS = 6;

function systemPrompt() {
  return `Si osobný asistent na nakupovanie a plánovanie jedál pre používateľa v Bratislave. Dnes je ${weekdayName()} ${todayISO()}.
Ceny a akcie máš v databáze týždenných letákov Lidl a Kaufland, ktorú čítaš cez nástroje. Na internet prístup nemáš.

Pravidlá:
- Pri každej otázke o cenách, akciách, nákupe alebo jedle z akcií použi nástroje. Nikdy si nevymýšľaj ceny ani produkty.
- Pri hľadaní produktov zadaj viac variantov slov (napr. 'kuracie prsia', 'kuracie prsne', 'kuracie rezne'). Ak nič nenájdeš, skús iné varianty skôr, než odpovieš, že produkt nie je.
- Ceny porovnávaj podľa unit_price (€/kg alebo €/l), nie podľa ceny balenia.
- Pri každej ponuke uveď obchod, cenu, prípadne pôvodnú cenu alebo zľavu a dokedy platí.
- Ak flags obsahuje card_price, spomeň, že ide o cenu s kartou (Kaufland Card). Ak name_truncated, názov môže byť neúplný.
- Pri otázke 'čo navariť z akcií' najprv zisti akcie (search_offers s only_discounted=true), potom navrhni 2 až 4 jedlá zo surovín v akcii (recepty z vlastných znalostí) a doplň k nim ceny.
- Pri otázke 'kde nakúpim na jedlo X najlacnejšie' rozlož jedlo na suroviny a použi compare_items.
- Zoznam 'moje potraviny' spravuj cez add_my_item, remove_my_item, list_my_items a vyhodnoť cez check_my_items. Napíš, čo sa oplatí kúpiť teraz (je v akcii) a čo kúpiť bežne.
- Pripomienky a opakované úlohy rieš cez add_task, list_tasks, delete_task.
- Existujú len príkazy /start a /reset. Nikdy nespomínaj ani nevymýšľaj iné príkazy. Zoznam potravín a úlohy sa spravujú bežnou vetou (napr. 'pridaj do mojich potravín mlieko'). Ak používateľ napíše neznámy príkaz (napr. /mylist), pochop z neho zámer a vykonaj ho.
- Nikdy nevypisuj interné značky ani vlastné uvažovanie, len konečnú odpoveď.
- Odpovedaj stručne po slovensky, čistým textom bez markdownu (Telegram), najviac asi 15 riadkov.`;
}

function toolSpecs() {
  return declarations().map((fn) => ({ type: "function", function: fn }));
}

// Cyklus: model žiada nástroje, my ich vykonáme a výsledky vrátime, kým model neodpovie textom.
export async function runAgent(env, text, { history = [] } = {}) {
  const deadline = newDeadline();
  const messages = [
    { role: "system", content: systemPrompt() },
    ...history.map((h) => ({ role: h.role === "model" ? "assistant" : h.role, content: h.text })),
    { role: "user", content: text },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    const reply = await chat(env, { messages, tools: lastStep ? undefined : toolSpecs() }, deadline);

    if (!reply.toolCalls.length) {
      if (!reply.text) throw new Error(`Prázdna odpoveď modelu ${reply.model}`);
      return reply.text;
    }

    messages.push({
      role: "assistant",
      content: reply.text || "",
      tool_calls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        _signature: c.signature, // vyžaduje ho Gemini 3, ostatné modely ho nedostanú
      })),
    });

    const results = await Promise.all(
      reply.toolCalls.map(async (c) => {
        let payload;
        try {
          payload = { result: await runTool(env, c.name, c.args) };
        } catch (err) {
          console.error(`Nástroj ${c.name} zlyhal:`, err);
          payload = { error: String(err?.message || err) };
        }
        return { role: "tool", tool_call_id: c.id, name: c.name, content: JSON.stringify(payload) };
      })
    );
    messages.push(...results);
  }
  throw new Error("Agent neskončil v rámci limitu krokov.");
}

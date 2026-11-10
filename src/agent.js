import { generate, newDeadline, textOf } from "./gemini.js";
import { declarations, runTool } from "./tools/index.js";
import { todayISO, weekdayName } from "./util.js";

const MAX_STEPS = 6;

function systemPrompt() {
  return `Si osobný asistent na nakupovanie a plánovanie jedál pre používateľa v Bratislave. Dnes je ${weekdayName()} ${todayISO()}.
Ceny a akcie máš v databáze týždenných letákov Lidl a Kaufland, ktorú čítaš cez nástroje.

Pravidlá:
- Pri každej otázke o cenách, akciách, nákupe alebo jedle z akcií použi nástroje. Nikdy si nevymýšľaj ceny ani produkty.
- Pri hľadaní produktov zadaj viac variantov slov (napr. 'kuracie prsia', 'kuracie prsne', 'kuracie rezne'). Ak nič nenájdeš, skús iné varianty skôr, než odpovieš, že produkt nie je.
- Ceny porovnávaj podľa unit_price (€/kg alebo €/l), nie podľa ceny balenia.
- Pri každej ponuke uveď obchod, cenu, prípadne pôvodnú cenu alebo zľavu a dokedy platí.
- Ak flags obsahuje card_price, spomeň, že ide o cenu s kartou (Kaufland Card). Ak name_truncated, názov môže byť neúplný.
- Pri otázke 'čo navariť z akcií' najprv zisti akcie (search_offers s only_discounted=true), potom navrhni 2 až 4 jedlá zo surovín v akcii a doplň k nim ceny.
- Pri otázke 'kde nakúpim na jedlo X najlacnejšie' rozlož jedlo na suroviny a použi compare_items.
- Zoznam 'moje potraviny' spravuj cez add_my_item, remove_my_item, list_my_items a vyhodnoť cez check_my_items. Napíš, čo sa oplatí kúpiť teraz (je v akcii) a čo kúpiť bežne.
- Pripomienky a opakované úlohy rieš cez add_task, list_tasks, delete_task.
- Odpovedaj stručne po slovensky, čistým textom bez markdownu (Telegram), najviac asi 15 riadkov.`;
}

// Cyklus: model žiada nástroje, my ich vykonáme a výsledky vrátime, kým model neodpovie textom.
export async function runAgent(env, text, { history = [] } = {}) {
  const deadline = newDeadline();
  const system = { parts: [{ text: systemPrompt() }] };
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text }] },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    const request = { systemInstruction: system, contents };
    if (!lastStep) request.tools = [{ functionDeclarations: declarations() }];

    const response = await generate(env, request, deadline);
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const out = textOf(response).trim();
      if (!out) {
        const finish = response.candidates?.[0]?.finishReason;
        throw new Error(`Prázdna odpoveď Gemini (finishReason: ${finish || "?"})`);
      }
      return out;
    }

    // Pôvodné parts (vrátane prípadných thought signatures) sa musia vrátiť nezmenené.
    contents.push({ role: "model", parts });
    const responses = await Promise.all(
      calls.map(async ({ functionCall: fc }) => {
        let response;
        try {
          response = { result: await runTool(env, fc.name, fc.args) };
        } catch (err) {
          console.error(`Nástroj ${fc.name} zlyhal:`, err);
          response = { error: String(err?.message || err) };
        }
        return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response } };
      })
    );
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("Agent neskončil v rámci limitu krokov.");
}

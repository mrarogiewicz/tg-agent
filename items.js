// "Moje potraviny": zoznam, ktorý si používateľ vedie, a kontrola, čo sa oplatí kúpiť teraz.
import { normalize } from "../util.js";
import { formatOffer, searchOffers } from "./offerSearch.js";

const MAX_ITEMS = 40;
let schemaReady;

// Tabuľku vlastní Worker (offers patrí Python extraktoru), preto sa vytvorí pri prvom použití.
function ensureSchema(env) {
  schemaReady ??= env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS my_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, terms TEXT NOT NULL, exclude TEXT, note TEXT)"
  )
    .run()
    .catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  return schemaReady;
}

async function listItems(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT id, name, terms, exclude, note FROM my_items ORDER BY name").all();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    terms: JSON.parse(r.terms),
    exclude: r.exclude ? JSON.parse(r.exclude) : [],
    note: r.note ?? undefined,
  }));
}

export const itemTools = [
  {
    name: "add_my_item",
    description:
      "Uloží potravinu do zoznamu 'moje potraviny' (to, čo používateľ pravidelne nakupuje). Ak položka s rovnakým názvom existuje, aktualizuje ju. Preferencie značky zapíš do terms (napr. name 'čokoláda', terms ['milka cokolada']).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Názov položky, napr. 'mlieko'." },
        terms: { type: "array", items: { type: "string" }, description: "Varianty na vyhľadávanie v letákoch." },
        exclude: { type: "array", items: { type: "string" }, description: "Slová, ktoré nechce (napr. ['bezlaktozove'])." },
        note: { type: "string", description: "Voľná poznámka (napr. 'iba 1,5 %')." },
      },
      required: ["name"],
    },
    async run(env, args) {
      await ensureSchema(env);
      const current = await listItems(env);
      const key = normalize(args.name).trim();
      if (!key) throw new Error("Chýba názov položky.");
      if (current.length >= MAX_ITEMS && !current.some((i) => normalize(i.name).trim() === key)) {
        throw new Error(`Zoznam má maximum ${MAX_ITEMS} položiek.`);
      }
      const terms = args.terms?.length ? args.terms : [args.name];
      await env.DB.prepare(
        "INSERT INTO my_items (name, name_norm, terms, exclude, note) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(name_norm) DO UPDATE SET name = excluded.name, terms = excluded.terms, exclude = excluded.exclude, note = excluded.note"
      )
        .bind(args.name, key, JSON.stringify(terms), args.exclude?.length ? JSON.stringify(args.exclude) : null, args.note ?? null)
        .run();
      return { saved: args.name, terms };
    },
  },
  {
    name: "remove_my_item",
    description: "Odstráni potravinu zo zoznamu 'moje potraviny'.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async run(env, args) {
      await ensureSchema(env);
      const res = await env.DB.prepare("DELETE FROM my_items WHERE name_norm = ?").bind(normalize(args.name).trim()).run();
      return { removed: (res.meta?.changes ?? 0) > 0 };
    },
  },
  {
    name: "list_my_items",
    description: "Vypíše zoznam 'moje potraviny'.",
    parameters: { type: "object", properties: {} },
    async run(env) {
      return { items: await listItems(env) };
    },
  },
  {
    name: "check_my_items",
    description:
      "Prejde zoznam 'moje potraviny' a ku každej položke vráti najlacnejšie aktuálne ponuky. Použi na otázky 'čo sa mi tento týždeň oplatí kúpiť'. Položky bez ponuky v letákoch sa kupujú v bežnom obchode za bežnú cenu.",
    parameters: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["current", "upcoming", "all"], description: "Predvolene current." },
      },
    },
    async run(env, args) {
      const items = await listItems(env);
      if (!items.length) return { items: [], hint: "Zoznam je prázdny." };
      const results = await Promise.all(
        items.map(async (item) => {
          const rows = await searchOffers(env, {
            terms: item.terms,
            exclude: item.exclude,
            when: args.when,
            sort: "unit_price",
            limit: 3,
          });
          return {
            name: item.name,
            note: item.note,
            on_sale: rows.some((r) => r.old_price != null || r.discount_pct != null),
            best: rows.map(formatOffer),
          };
        })
      );
      return { items: results };
    },
  },
];

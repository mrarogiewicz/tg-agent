import { formatOffer, searchOffers } from "./offerSearch.js";

const WHEN = {
  type: "string",
  enum: ["current", "upcoming", "all"],
  description: "current = letáky platné dnes (predvolené), upcoming = letáky platné od budúceho týždňa, all = oboje",
};

const TERMS = {
  type: "array",
  items: { type: "string" },
  description:
    "Varianty hľadaného produktu, napr. ['kuracie prsia', 'kuracie prsne', 'kuracie rezne']. Medzi variantmi platí ALEBO, v rámci jedného variantu sa musia nájsť všetky slová.",
};

const EXCLUDE = {
  type: "array",
  items: { type: "string" },
  description: "Slová, ktoré sa v názve nesmú vyskytovať (napr. ['korenie', 'konzerva']).",
};

export const offerTools = [
  {
    name: "search_offers",
    description:
      "Vyhľadá produkty v aktuálnych letákoch (Lidl, Kaufland) podľa slov v názve. Vráti najlacnejšie ponuky, predvolene zoradené podľa ceny za kg/l. Slúži aj na zoznam akcií (only_discounted=true, sort=discount).",
    parameters: {
      type: "object",
      properties: {
        terms: TERMS,
        exclude: EXCLUDE,
        store: { type: "string", description: "Obmedzí na jeden obchod: lidl alebo kaufland." },
        only_discounted: { type: "boolean", description: "Len produkty v zľave (má pôvodnú cenu alebo % zľavy)." },
        sort: { type: "string", enum: ["unit_price", "price", "discount"], description: "Predvolene unit_price (€/kg alebo €/l)." },
        limit: { type: "integer", description: "Počet výsledkov, predvolene 10, max 20." },
        when: WHEN,
      },
    },
    async run(env, args) {
      const rows = await searchOffers(env, {
        terms: args.terms,
        exclude: args.exclude,
        store: args.store,
        when: args.when,
        onlyDiscounted: args.only_discounted,
        sort: args.sort,
        limit: Math.min(Number(args.limit) || 10, 20),
      });
      return { count: rows.length, offers: rows.map(formatOffer) };
    },
  },
  {
    name: "compare_items",
    description:
      "Pre zoznam surovín alebo produktov nájde v každom obchode najlacnejšiu ponuku. Použi pri otázkach typu 'kde nakúpim na toto jedlo najlacnejšie' alebo pri nákupnom zozname.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Max 12 položiek.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Názov položky pre používateľa, napr. 'kuracie prsia'." },
              terms: TERMS,
              exclude: EXCLUDE,
            },
            required: ["name", "terms"],
          },
        },
        when: WHEN,
      },
      required: ["items"],
    },
    async run(env, args) {
      const items = (args.items ?? []).slice(0, 12);
      const results = await Promise.all(
        items.map(async (item) => {
          const rows = await searchOffers(env, {
            terms: item.terms?.length ? item.terms : [item.name],
            exclude: item.exclude,
            when: args.when,
            sort: "unit_price",
            limit: 200,
          });
          const bestByStore = {};
          for (const r of rows) if (!bestByStore[r.store]) bestByStore[r.store] = formatOffer(r);
          return { name: item.name, matches: rows.length, best_by_store: Object.values(bestByStore) };
        })
      );
      return { items: results };
    },
  },
];

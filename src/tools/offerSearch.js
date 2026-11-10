// Spoločné pomocné funkcie na vyhľadávanie v letákoch (tabuľka `offers` v D1, plní ju Python extraktor).
import { normalize, todayISO } from "../util.js";

const MAX_TERMS = 8;
const MAX_WORDS_PER_TERM = 5;
const MAX_EXCLUDE_WORDS = 10;

// Skracuje slová o koncovku, aby "prsia" našlo aj "prsné" a "mlieko" aj "mliečne".
function stem(word) {
  return word.length >= 5 ? word.slice(0, word.length - 2) : word;
}

export function toStems(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .map(stem);
}

const SELECT_COLUMNS =
  "store, name, details, price, old_price, discount_pct, unit_price, unit_price_unit, valid_from, valid_to, flags";

const SORTS = {
  unit_price: "(unit_price IS NULL), unit_price, price",
  price: "price",
  discount: "COALESCE(discount_pct, 0) DESC, price",
};

function buildFilter({ terms, exclude, store, when, onlyDiscounted }) {
  const today = todayISO();
  const where = [];
  const params = [];

  if (when === "upcoming") {
    where.push("valid_from > ?");
    params.push(today);
  } else if (when === "all") {
    where.push("valid_to >= ?");
    params.push(today);
  } else {
    where.push("valid_from <= ? AND valid_to >= ?");
    params.push(today, today);
  }

  const groups = [];
  for (const term of (terms ?? []).slice(0, MAX_TERMS)) {
    const stems = toStems(term).slice(0, MAX_WORDS_PER_TERM);
    if (!stems.length) continue;
    groups.push("(" + stems.map(() => "search_text LIKE ?").join(" AND ") + ")");
    params.push(...stems.map((s) => `%${s}%`));
  }
  if (groups.length) where.push("(" + groups.join(" OR ") + ")");

  const excludeStems = (exclude ?? []).flatMap(toStems).slice(0, MAX_EXCLUDE_WORDS);
  for (const s of excludeStems) {
    where.push("search_text NOT LIKE ?");
    params.push(`%${s}%`);
  }

  if (store) {
    where.push("store = ?");
    params.push(normalize(store));
  }
  if (onlyDiscounted) where.push("(old_price IS NOT NULL OR discount_pct IS NOT NULL)");

  return { clause: where.join(" AND "), params };
}

export function formatOffer(r) {
  return {
    store: r.store,
    name: r.name,
    details: (r.details || "").slice(0, 90) || undefined,
    price: r.price,
    old_price: r.old_price ?? undefined,
    discount_pct: r.discount_pct ?? undefined,
    unit_price: r.unit_price == null ? undefined : `${r.unit_price} €/${r.unit_price_unit}`,
    valid: `${r.valid_from}..${r.valid_to}`,
    flags: r.flags || undefined,
  };
}

export async function searchOffers(env, { terms, exclude, store, when, onlyDiscounted, sort = "unit_price", limit = 10 }) {
  const { clause, params } = buildFilter({ terms, exclude, store, when, onlyDiscounted });
  const order = SORTS[sort] ?? SORTS.unit_price;
  const capped = Math.max(1, Math.min(Number(limit) || 10, 200));
  const sql = `SELECT ${SELECT_COLUMNS} FROM offers WHERE ${clause} ORDER BY ${order} LIMIT ${capped}`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results;
}

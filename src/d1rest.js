// D1 cez REST API, keď Worker nemá D1 binding. Rozhranie kopíruje env.DB (prepare/bind/all/run),
// takže nástroje fungujú rovnako s bindingom aj bez neho. ID databázy a token sú vo Worker Secrets.

const API = "https://api.cloudflare.com/client/v4/accounts";
const TIMEOUT_MS = 15000;

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  return "'" + String(value).replace(/\0/g, "").replace(/'/g, "''") + "'";
}

// Dosadí parametre do "?" zástupných znakov. Hodnoty sa escapujú ako SQL literály.
export function interpolate(sql, params) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error("Počet parametrov nesedí s SQL.");
    return literal(params[i++]);
  });
  if (i !== params.length) throw new Error("Počet parametrov nesedí s SQL.");
  return out;
}

class RestStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
    const result = await this.db.query(interpolate(this.sql, this.params));
    return { results: result.results ?? [], meta: result.meta ?? {} };
  }

  async run() {
    return this.all();
  }
}

class RestDb {
  constructor(env) {
    this.url = `${API}/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
    this.token = env.CF_API_TOKEN;
  }

  prepare(sql) {
    return new RestStatement(this, sql);
  }

  async query(sql) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.success) {
      throw new Error(`D1 chyba ${r.status}: ${JSON.stringify(data?.errors ?? "neznáma odpoveď")}`);
    }
    return data.result[0];
  }
}

export const REST_ENV_KEYS = ["CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"];

// Vráti env s nastaveným DB (binding alebo REST) a zoznam toho, čo chýba.
export function withDb(env) {
  if (env.DB) return { env, missing: [] };
  const missing = REST_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length) return { env, missing };
  return { env: { ...env, DB: new RestDb(env) }, missing: [] };
}

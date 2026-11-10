# tg-agent

Telegram agent na Cloudflare Workers. Hlavný model beží v Cloudflare Workers AI, záloha je Gemini.
Pýtaš sa cez Telegram, agent volá nástroje (function calling) a odpovedá.

## Čo vie
- **Letáky Lidl a Kaufland** (D1 plní repo `leaflets-agent`): najlacnejšie ponuky, akcie, porovnanie surovín podľa obchodov, "moje potraviny" a čo sa z nich oplatí kúpiť.
- **Naplánované úlohy** (napr. "každý pondelok o 8:00 pošli akcie na mäso"), cron každú minútu.
- Krátka história rozhovoru (2 hodiny), `/reset` ju zmaže.

## Štruktúra
- `src/index.js` webhook, cron, Telegram
- `src/agent.js` cyklus model -> nástroje -> odpoveď, systémový prompt
- `src/llm.js` reťaz modelov: skúša ich v poradí zo `src/models.js`, kým jeden neodpovie
- `src/workersai.js`, `src/gemini.js` adaptéry poskytovateľov (spoločný formát správ a nástrojov)
- `src/tools/` nástroje; nová schopnosť = nový súbor a riadok v `src/tools/index.js`

## Nastavenie
Secrets (Cloudflare -> Worker -> Settings -> Variables and Secrets):
TG_TOKEN, OWNER_ID, SECRET a voliteľne GEMINI_KEY (záloha, ak zlyhá Workers AI; Google Search nepoužíva).

Workers AI sa pripája väzbou `AI` vo `wrangler.toml` (bez kľúča, zadarmo 10 000 neurónov denne).

Letáky v D1 sa čítajú cez REST API (`src/d1rest.js`), aby ID databázy nebolo v repozitári. Doplň ďalšie Secrets:
CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN (token s oprávnením Account -> D1 -> Edit).
Ak pridáš D1 binding `DB` do `wrangler.toml`, použije sa namiesto REST.

Binding `KV` (úlohy, história) je vo `wrangler.toml`.

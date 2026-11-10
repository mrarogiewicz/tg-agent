// Register nástrojov. Nová schopnosť = nový súbor s poľom nástrojov a jeden riadok tu.
import { offerTools } from "./offers.js";
import { itemTools } from "./items.js";
import { taskTools } from "./tasks.js";
import { webTools } from "./web.js";

const TOOLS = [...offerTools, ...itemTools, ...taskTools, ...webTools];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function declarations() {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function runTool(env, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Neznámy nástroj: ${name}`);
  return tool.run(env, args ?? {});
}

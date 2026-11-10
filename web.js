import { geminiText } from "../gemini.js";

export const webTools = [
  {
    name: "web_answer",
    description:
      "Vyhľadá odpoveď na internete cez Google (aktuálne informácie, recepty, všeobecné otázky). Nepoužívaj na ceny v obchodoch, na tie slúžia nástroje s letákmi.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    async run(env, args) {
      const answer = await geminiText(env, `${args.question}\nOdpovedz strucne po slovensky.`, { search: true });
      return { answer };
    },
  },
];

// Naplánované úlohy v KV; ich spúšťanie rieši cron v index.js.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function loadTasks(env) {
  return JSON.parse((await env.KV.get("tasks")) || "[]");
}

export const taskTools = [
  {
    name: "add_task",
    description:
      "Naplánuje opakovanú úlohu. Asistent ju v daný čas sám vykoná a pošle výsledok do Telegramu (napr. 'každý pondelok o 8:00 pošli akcie na mäso').",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "Čas HH:MM (24 h, čas Bratislavy)." },
        days: { type: "string", enum: ["daily", "weekdays"], description: "daily = každý deň, weekdays = len pracovné dni." },
        prompt: { type: "string", description: "Samostatné zadanie, čo má asistent urobiť pri každom spustení." },
      },
      required: ["time", "days", "prompt"],
    },
    async run(env, args) {
      if (!TIME_RE.test(args.time ?? "")) throw new Error("Čas musí byť vo formáte HH:MM.");
      const tasks = await loadTasks(env);
      const task = { id: Date.now().toString(36), time: args.time, days: args.days, prompt: args.prompt };
      tasks.push(task);
      await env.KV.put("tasks", JSON.stringify(tasks));
      return { created: task };
    },
  },
  {
    name: "list_tasks",
    description: "Vypíše naplánované úlohy.",
    parameters: { type: "object", properties: {} },
    async run(env) {
      return { tasks: await loadTasks(env) };
    },
  },
  {
    name: "delete_task",
    description: "Zmaže naplánovanú úlohu podľa jej id (id zistíš cez list_tasks).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(env, args) {
      const tasks = await loadTasks(env);
      const next = tasks.filter((t) => t.id !== args.id);
      await env.KV.put("tasks", JSON.stringify(next));
      return { deleted: next.length !== tasks.length };
    },
  },
];

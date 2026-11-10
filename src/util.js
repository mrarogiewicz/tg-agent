export const TZ = "Europe/Bratislava";

// Malé písmená bez diakritiky; rovnaké pravidlo ako normalize_text() v extraktore letákov.
export function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Dnešný dátum v tvare YYYY-MM-DD v čase Bratislavy.
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(now);
}

export function weekdayName(now = new Date()) {
  return new Intl.DateTimeFormat("sk-SK", { timeZone: TZ, weekday: "long" }).format(now);
}

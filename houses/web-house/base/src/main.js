import { addDays, formatDay } from "./dates.js";

const start = new Date("2026-12-24");
for (let i = 0; i < 3; i++) console.log(`Day ${i + 1}: ${formatDay(addDays(start, i))}`);

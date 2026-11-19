// Date helpers we would like to replace with a proper library.
export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function formatDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

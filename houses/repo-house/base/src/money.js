// Format an integer amount of cents as a currency string.
export function formatCents(cents, currency = "USD") {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  const symbol = currency === "EUR" ? "€" : currency === "KRW" ? "₩" : "$";
  return `${sign}${symbol}${whole}.${frac}`;
}

// Parse "12.34" into 1234 cents.
export function parseCents(text) {
  const [whole, frac = ""] = String(text).trim().split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

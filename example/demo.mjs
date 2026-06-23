/**
 * inspectctl demo target
 *
 * Showcases:
 *   breakpoint / eval / get_locals  — processOrder() pauses with rich locals
 *   step_into / step_out            — computePrice() is a good step target
 *   heap_snapshot / heap_diff       — leaky Map grows every 300ms
 *   profile_cpu                     — GET /cpu burns a core for 500ms
 *   list_async                      — HTTP server + 2 timers visible as handles
 *   tail_logs                       — every order logs to console
 *   get_stack                       — burnCpu tight loop shows interesting stack
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ── memory leak ──────────────────────────────────────────────────────────────
const cache = new Map();
setInterval(() => {
  cache.set(randomUUID(), new Array(500).fill("leak"));
}, 300);

// ── business logic ───────────────────────────────────────────────────────────
function computePrice(basePrice, taxRate, discount) {
  const tax = basePrice * taxRate;
  const total = basePrice + tax - discount;
  return Math.round(total * 100) / 100;
}

function processOrder(orderId, items) {         // ← good breakpoint target
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const price = computePrice(subtotal, 0.08, subtotal > 100 ? 10 : 0);
  const order = { orderId, items, subtotal, price, ts: Date.now() };
  console.log("[order]", JSON.stringify(order));
  return order;
}

// ── cpu burner ───────────────────────────────────────────────────────────────
function burnCpu(ms) {
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) n = (n * 31 + 7) & 0xffffffff;
  return n;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = 4000;
createServer((req, res) => {
  if (req.url === "/order") {
    const items = [
      { name: "Widget",  price: 49.99 },
      { name: "Gadget",  price: 79.99 },
      { name: "Doohickey", price: 9.99 },
    ];
    const result = processOrder(randomUUID(), items);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return;
  }
  if (req.url === "/cpu") {
    const result = burnCpu(500);
    res.end(`burned, result=${result}`);
    return;
  }
  if (req.url === "/cache-size") {
    res.end(String(cache.size));
    return;
  }
  res.end("ok — try /order  /cpu  /cache-size");
}).listen(PORT, () => {
  console.log(`demo listening on http://127.0.0.1:${PORT}`);
  console.log("debugger on ws://127.0.0.1:9229");
  console.log("endpoints: /order  /cpu  /cache-size");
});

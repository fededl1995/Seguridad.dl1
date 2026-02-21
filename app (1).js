/**
 * Versión "Excel en vivo": la web lee catalogo.xlsx en el navegador.
 * ✅ Para actualizar precios: reemplazá catalogo.xlsx y recargá.
 *
 * IMPORTANTE:
 * - Esto funciona en hosting o servidor local (http://...), NO con doble click file://
 */
const WHATSAPP_NUMBER = "54911XXXXXXXXXX";
const EXCEL_FILE = "catalogo.xlsx";

// Orden deseado de solapas (si existen). Si falta alguna, se ignora.
const SHEET_ORDER = ["DAHUA","HIKVISION","IMOU","CYGNUS","INTELBRAS","MARSHALL-GARNET","CERCO ELECTRICO"];
const SHEET_LABEL = {
  "MARSHALL-GARNET": "Marshall / Garnet",
  "CERCO ELECTRICO": "Cerco Eléctrico",
};

const $ = (sel) => document.querySelector(sel);

const fmtARS = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const fmtUSD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function safeText(s) { return (s ?? "").toString(); }

function priceARS(p) {
  if (typeof p.price_ars === "number" && p.price_ars > 0) return p.price_ars;
  return 0;
}

function whatsappLink(message) {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return `${base}?text=${encodeURIComponent(message)}`;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b, "es"));
}

function scoreRelevance(p, q) {
  if (!q) return 0;
  const hay = `${p.code} ${p.category} ${p.type} ${p.description}`.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of terms) {
    if (p.code.toLowerCase().includes(t)) score += 6;
    if (p.category.toLowerCase().includes(t)) score += 3;
    if (hay.includes(t)) score += 1;
  }
  return score;
}

function slug(s) {
  return safeText(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]+/g, "")
    .slice(0, 90);
}

// ------------------ CART ------------------
const CART_KEY = "deffer_cart_v1";

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {}
  return {};
}
function saveCart(cart) { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
function cartCount(cart) { return Object.values(cart).reduce((a, b) => a + b, 0); }

function cartTotal(cart, byId) {
  let sum = 0;
  for (const [id, qty] of Object.entries(cart)) {
    const p = byId.get(id);
    if (!p) continue;
    sum += priceARS(p) * qty;
  }
  return sum;
}

function cartMessage(cart, byId) {
  const lines = [];
  lines.push("Hola! Quiero consultar / pedir estos productos:");
  lines.push("");
  for (const [id, qty] of Object.entries(cart)) {
    const p = byId.get(id);
    if (!p) continue;
    const ars = priceARS(p);
    const priceTxt = ars > 0 ? fmtARS.format(ars) : (typeof p.price_usd === "number" ? fmtUSD.format(p.price_usd) : "s/p");
    lines.push(`• ${qty} x ${p.code} (${p.category}) — ${priceTxt}`);
  }
  lines.push("");
  lines.push("Gracias!");
  return lines.join("\n");
}

// ------------------ EXCEL LOADER ------------------
function normalizeHeader(h) {
  // normaliza: trim + mayúsculas + sin acentos + espacios compactos
  return safeText(h)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function findCol(headers, candidates) {
  const up = headers.map(normalizeHeader);
  const cand = candidates.map(c => normalizeHeader(c));

  // 1) match exacto
  for (const c of cand) {
    const i = up.indexOf(c);
    if (i !== -1) return i;
  }

  // 2) match por inclusión (ej: "COD." "CODIGO/MODELO", etc.)
  for (const c of cand) {
    const i = up.findIndex(h => h.includes(c));
    if (i !== -1) return i;
  }

  return -1;
}

function parseNumberLike(v) {
  const s = safeText(v).trim();
  if (!s) return NaN;
  // quitar moneda y espacios
  let x = s.replace(/[^0-9,.-]+/g, "");
  // si trae miles con punto y decimales con coma: 1.234.567,89
  // o miles con coma y decimales con punto: 1,234,567.89
  const hasComma = x.includes(",");
  const hasDot = x.includes(".");
  if (hasComma && hasDot) {
    // asumimos que el separador decimal es el ÚLTIMO de ambos
    const lastComma = x.lastIndexOf(",");
    const lastDot = x.lastIndexOf(".");
    const decIsComma = lastComma > lastDot;
    if (decIsComma) {
      x = x.replace(/\./g, "").replace(",", ".");
    } else {
      x = x.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // "1234,56" => "1234.56"
    x = x.replace(",", ".");
  } else {
    // solo dot o solo números: ok
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function guessHeaderRowIndex(rows) {
  const headerHints = ["COD", "CODIGO", "MODELO", "DESCRIP", "DETALLE", "PRECIO", "PESO", "DOLAR", "USD", "ARS"];
  const maxScan = Math.min(6, rows.length);
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i] || [];
    const joined = row.map(normalizeHeader).join(" | ");
    if (headerHints.some(h => joined.includes(h))) return i;
  }
  return 0;
}

function guessNumericCol(rows, startRow, exclude = new Set()) {
  // escanea primeras filas de datos para encontrar la columna más "numérica"
  const sample = rows.slice(startRow, startRow + 15);
  const width = Math.max(...sample.map(r => (r || []).length), 0);
  let bestCol = -1;
  let bestScore = 0;
  for (let c = 0; c < width; c++) {
    if (exclude.has(c)) continue;
    let score = 0;
    for (const r of sample) {
      const v = (r || [])[c];
      const n = typeof v === "number" ? v : parseNumberLike(v);
      if (Number.isFinite(n) && n !== 0) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = c;
    }
  }
  return bestCol;
}

function isNumericLike(v) {
  const s = safeText(v).trim();
  if (!s) return false;
  // acepta 12.345,67 / 12345.67 / 12345
  const cleaned = s
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/\$/g, "")
    .replace(/\s+/g, "");
  return cleaned !== "" && !Number.isNaN(Number(cleaned));
}

function toNumberFlexible(v) {
  const s = safeText(v).trim();
  if (!s) return NaN;
  // 12.345,67 -> 12345.67
  const cleaned = s
    .replace(/\$/g, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");
  return Number(cleaned);
}

async function loadExcelProducts() {
  if (!window.XLSX) {
    throw new Error("No se cargó la librería XLSX. Revisá conexión o el script CDN.");
  }

  const res = await fetch(EXCEL_FILE, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`No pude leer ${EXCEL_FILE}. Estado HTTP: ${res.status}.`);
  }
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  // Elegimos solapas: primero las del orden fijo que existan; luego el resto.
  const existing = wb.SheetNames.slice();
  const ordered = [];
  for (const s of SHEET_ORDER) if (existing.includes(s)) ordered.push(s);
  for (const s of existing) if (!ordered.includes(s)) ordered.push(s);

  const products = [];
  const categories = [];
  ordered.forEach((sheetName, sheetIndex) => {
    const ws = wb.Sheets[sheetName];
    if (!ws) return;

    // Siempre registramos la categoría/solapa (aunque quede vacía o no se pueda leer)
    const categoryLabel = SHEET_LABEL[sheetName] || sheetName.charAt(0) + sheetName.slice(1).toLowerCase();
    categories.push(categoryLabel);

    // rows: array de arrays; preserva orden y vacíos
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows.length) return;

    const headers = rows[0] || [];
    let codeCol = findCol(headers, ["MODELO", "CODIGO", "COD.", "COD", "CÓDIGO", "CODIGO/MODELO", "MODELO/CODIGO"]);
    let descCol = findCol(headers, ["DESCRIPCIÓN", "DESCRIPCION", "DETALLE", "DESCRIPCION/DETALLE"]);
    let typeCol = findCol(headers, ["TIPO", "CATEGORIA", "LÍNEA", "LINEA"]);
    let arsCol  = findCol(headers, ["PESOS", "ARS", "PRECIO", "PRECIO ARS", "PRECIO $", "$", "PRECIO (ARS)"]);
    let usdCol  = findCol(headers, ["DOLARES", "DOLARES USD", "USD", "DOLAR", "U$S", "PRECIO USD", "PRECIO (USD)"]);
    // imagen opcional por si en el futuro lo querés
    const imgCol  = findCol(headers, ["IMAGEN"]);

    // Si no pudimos detectar columnas, usamos heurística mínima para no perder la categoría
    if (codeCol === -1) codeCol = 0;
    if (descCol === -1) descCol = 1;

    // Si no detectamos precio ARS/USD por encabezado, buscamos una columna mayormente numérica
    if (arsCol === -1 && rows.length > 2) {
      const colCount = Math.max(...rows.map(r => (r || []).length));
      let best = { idx: -1, hits: 0 };
      for (let c = 0; c < colCount; c++) {
        let hits = 0;
        for (let rr = 1; rr < Math.min(rows.length, 11); rr++) {
          if (isNumericLike((rows[rr] || [])[c])) hits++;
        }
        if (hits > best.hits) best = { idx: c, hits };
      }
      if (best.idx !== -1 && best.hits >= 2) arsCol = best.idx;
    }

    // data rows start at 1
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const code = safeText(row[codeCol]).trim();
      if (!code) continue;

      const description = descCol !== -1 ? safeText(row[descCol]).trim() : "";
      const type = typeCol !== -1 ? safeText(row[typeCol]).trim() : "";

      const price_ars = arsCol !== -1 ? toNumberFlexible(row[arsCol]) : NaN;
      const price_usd = usdCol !== -1 ? toNumberFlexible(row[usdCol]) : NaN;

      // Si el Excel trae algo raro, convertimos a null
      const ars = Number.isFinite(price_ars) ? price_ars : null;
      const usd = Number.isFinite(price_usd) ? price_usd : null;

      const image = imgCol !== -1 ? safeText(row[imgCol]).trim() : "";

      // ID estable: categoria + codigo + row para evitar duplicados
      const id = `${slug(categoryLabel)}-${slug(code)}-${r}`;

      products.push({
        id,
        code,
        category: categoryLabel,
        type,
        description,
        price_ars: ars,
        price_usd: usd,
        image,
        sheet_index: sheetIndex,
        row_index: r - 1, // fila relativa dentro de la solapa (0 = primera fila de datos)
      });
    }
  });

  return { products, categories };
}

// ------------------ UI (CATÁLOGO) ------------------
let all = [];
let excelCategories = []; // categorías/solapas detectadas en el Excel (ordenadas)
let cart = loadCart();
let byId = new Map();

function excelComparator(a, b) {
  if (a.sheet_index !== b.sheet_index) return a.sheet_index - b.sheet_index;
  return a.row_index - b.row_index;
}

function updateHeaderCounts(visibleCount) {
  $("#cartCount").textContent = cartCount(cart);
  $("#productsCount").textContent = all.length ? `${all.length} productos` : "0 productos";
  $("#kpiTotal").textContent = all.length;
  $("#kpiCategories").textContent = excelCategories.length || uniqueSorted(all.map(p => p.category)).length;
  $("#kpiVisible").textContent = visibleCount ?? all.length;
}

function cardHTML(p) {
  const ars = priceARS(p);
  const arsTxt = ars > 0 ? fmtARS.format(ars) : "";
  const usdTxt = (typeof p.price_usd === "number" && p.price_usd > 0) ? fmtUSD.format(p.price_usd) : "";
  const desc = safeText(p.description);
  const short = desc.length > 170 ? desc.slice(0, 170).trim() + "…" : desc;

  const img = safeText(p.image);
  const thumbInner = img
    ? `<img src="${img}" alt="${p.code}" loading="lazy" />`
    : `<span aria-hidden="true">📷</span>`;

  const msg = `Hola! Quiero consultar por ${p.code} (${p.category}).`;
  const wlink = whatsappLink(msg);

  return `
    <article class="card">
      <div class="head">
        <div class="thumb">${thumbInner}</div>
        <div>
          <div class="code">${p.code}</div>
          <div class="meta">${p.type ? p.type : p.category}</div>
        </div>
      </div>
      <div class="desc">${short || "<span class='small'>Sin descripción.</span>"}</div>
      <div class="price">
        <div class="ars">${arsTxt || (usdTxt ? "Consultar" : "S/P")}</div>
        <div class="usd">${usdTxt ? `USD ${usdTxt}` : ""}</div>
      </div>
      <div class="actions">
        <button class="btn" data-add="${p.id}" type="button">Agregar</button>
        <a class="btn primary" href="${wlink}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    </article>
  `;
}

function buildCategoryOptions() {
  // mostramos TODAS las solapas del Excel, aunque alguna no tenga productos
  const categories = excelCategories.length ? excelCategories.slice() : uniqueSorted(all.map(p => p.category));
  const sel = $("#category");
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "Todas";
  sel.appendChild(optAll);

  categories.forEach(c => {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  });
}

function groupByCategoryExact(arr) {
  // arr assumed sorted by excelComparator
  const map = new Map();
  for (const p of arr) {
    const key = p.category || "Sin categoría";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const groups = Array.from(map.entries());
  groups.sort((a, b) => excelComparator(a[1][0], b[1][0]));
  for (const [, items] of groups) items.sort((x, y) => x.row_index - y.row_index);
  return groups;
}

function applyFilters() {
  const q = $("#q").value.trim();
  const category = $("#category").value;
  const sort = $("#sort").value;

  let arr = all.slice();

  if (q) {
    const qq = q.toLowerCase();
    arr = arr.filter(p => (`${p.code} ${p.category} ${p.type} ${p.description}`.toLowerCase().includes(qq)));
  }
  if (category) arr = arr.filter(p => p.category === category);

  if (sort === "excel") {
    arr.sort(excelComparator);
  } else if (sort === "priceAsc") {
    arr.sort((a, b) => priceARS(a) - priceARS(b));
  } else if (sort === "priceDesc") {
    arr.sort((a, b) => priceARS(b) - priceARS(a));
  } else if (sort === "codeAsc") {
    arr.sort((a, b) => a.code.localeCompare(b.code, "es"));
  } else {
    if (q) arr.sort((a, b) => scoreRelevance(b, q) - scoreRelevance(a, q));
    else arr.sort(excelComparator);
  }

  renderGrouped(arr);
  updateHeaderCounts(arr.length);
}

function renderGrouped(arr) {
  const grid = $("#grid");
  const grouped = groupByCategoryExact(arr.sort(excelComparator));

  grid.innerHTML = grouped.map(([cat, items]) => {
    const inner = items.map(cardHTML).join("");
    return `
      <details class="group" open>
        <summary>
          <span class="group-title">${cat}</span>
          <span class="spacer"></span>
          <span class="group-count">${items.length}</span>
        </summary>
        <div class="group-inner">
          <div class="grid">${inner}</div>
        </div>
      </details>
    `;
  }).join("") || `<div class="small">No hay resultados con esos filtros.</div>`;
}

function bindClicks() {
  $("#grid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    const id = btn.getAttribute("data-add");
    cart[id] = (cart[id] || 0) + 1;
    saveCart(cart);
    updateHeaderCounts($("#kpiVisible").textContent);
  });
}

// ------------------ CART MODAL ------------------
function openCart() { $("#cartBackdrop").style.display = "flex"; renderCart(); }
function closeCart() { $("#cartBackdrop").style.display = "none"; }

function renderCart() {
  const itemsEl = $("#cartItems");
  const entries = Object.entries(cart);

  if (!entries.length) {
    itemsEl.innerHTML = `<div class="small">Tu carrito está vacío. Agregá productos desde el catálogo.</div>`;
  } else {
    entries.sort((a, b) => excelComparator(byId.get(a[0]) || {}, byId.get(b[0]) || {}));

    itemsEl.innerHTML = entries.map(([id, qty]) => {
      const p = byId.get(id);
      if (!p) return "";
      const ars = priceARS(p);
      const priceTxt = ars > 0 ? fmtARS.format(ars) : (typeof p.price_usd === "number" ? fmtUSD.format(p.price_usd) : "s/p");
      return `
        <div class="cart-row">
          <div class="left">
            <div><b>${p.code}</b> <span class="meta">(${p.category})</span></div>
            <div class="small">${priceTxt}</div>
          </div>
          <div class="qty">
            <button class="btn" data-dec="${id}" type="button">−</button>
            <div><b>${qty}</b></div>
            <button class="btn" data-inc="${id}" type="button">+</button>
            <button class="btn" data-del="${id}" type="button">🗑</button>
          </div>
        </div>
      `;
    }).join("");
  }

  const total = cartTotal(cart, byId);
  $("#cartTotal").textContent = total > 0 ? fmtARS.format(total) : "Total a confirmar";

  const msg = cartMessage(cart, byId);
  $("#btnWhatsappCart").href = whatsappLink(msg);
}

function bindCartClicks() {
  $("#cartItems").addEventListener("click", (e) => {
    const inc = e.target.closest("[data-inc]");
    const dec = e.target.closest("[data-dec]");
    const del = e.target.closest("[data-del]");
    const id = (inc || dec || del)?.getAttribute(inc ? "data-inc" : dec ? "data-dec" : "data-del");
    if (!id) return;

    if (inc) cart[id] = (cart[id] || 0) + 1;
    if (dec) cart[id] = Math.max(0, (cart[id] || 0) - 1);
    if (del) cart[id] = 0;

    if (cart[id] === 0) delete cart[id];

    saveCart(cart);
    updateHeaderCounts();
    renderCart();
  });
}

// ------------------ INIT ------------------
async function init() {
  $("#btnWhatsappTop").href = whatsappLink("Hola! Quiero consultar por cámaras y sistemas de seguridad.");

  // Listeners UI
  ["q", "category", "sort"].forEach(id => {
    const el = $("#" + id);
    el.addEventListener(id === "q" ? "input" : "change", applyFilters);
  });

  $("#btnClear").addEventListener("click", () => {
    $("#q").value = "";
    $("#category").value = "";
    $("#sort").value = "excel";
    applyFilters();
  });

  bindClicks();

  // cart modal
  $("#btnOpenCart").addEventListener("click", openCart);
  $("#btnCloseCart").addEventListener("click", closeCart);
  $("#cartBackdrop").addEventListener("click", (e) => {
    if (e.target === $("#cartBackdrop")) closeCart();
  });
  bindCartClicks();

  // Load Excel
  try {
    $("#loadingMsg").textContent = "Cargando catálogo desde el Excel…";
    const { products, categories } = await loadExcelProducts();
    excelCategories = Array.from(new Set(categories));
    all = products;
    all.sort(excelComparator);

    byId = new Map(all.map(p => [p.id, p]));
    buildCategoryOptions();
    updateHeaderCounts(all.length);

    $("#loadingMsg")?.remove();
    applyFilters();

    // Show runtime note
    const note = $("#runtimeNote");
    note.style.display = "block";
    note.textContent = "✅ Para actualizar el catálogo: reemplazá el archivo catalogo.xlsx por uno nuevo (mismo nombre) y recargá la página.";
  } catch (err) {
    console.error(err);
    $("#productsCount").textContent = "Error";
    $("#grid").innerHTML = `
      <div class="notice">
        <b>No pude cargar el Excel.</b><br/>
        ${safeText(err.message)}<br/><br/>
        <b>Solución rápida:</b> abrí esta carpeta con un servidor local o subila a tu hosting.<br/>
        (En el README está el paso a paso.)
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", init);

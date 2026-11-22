// Cloudflare Worker — intermediario entre la web y la API v3 de Ecowitt.
// Guarda las claves como secretos (ECOWITT_APP_KEY, ECOWITT_API_KEY) y entrega JSON limpio.
//
// Endpoints:
//   GET /now               -> última lectura de cada estación
//   GET /day?date=AAAA-MM-DD -> serie de 5 min (T, HR) de cada estación para ese día local (America/Santiago)
//   GET /stations          -> lista de estaciones configuradas

const TZ = "America/Santiago";
const API = "https://api.ecowitt.net/api/v3/device";

// Edite aquí para agregar o quitar estaciones (alt en m s.n.m. es opcional).
const STATIONS = [
  { id: "titi-lafon",       name: "Titi Lafon UCH",                   mac: "E8:DB:84:F2:B5:4F", lat: -32.7445871, lon: -70.6990003 },
  { id: "villa-yevide",     name: "Villa Yevide UCH",                 mac: "E8:DB:84:F2:E6:48", lat: -32.7519125, lon: -70.7363905 },
  { id: "silvia-hurtado",   name: "Silvia Hurtado UCH",               mac: "E8:DB:84:F3:25:F3", lat: -32.7602370, lon: -70.7114489 },
  { id: "almendral",        name: "Almendral UCH",                    mac: "38:44:BE:92:C8:14", lat: -32.7529198, lon: -70.6895383 },
  { id: "esc-agricola",     name: "Esc. Agrícola UCH",                mac: "38:44:BE:92:BF:38", lat: -32.7545479, lon: -70.7052810 },
  { id: "grevillea",        name: "Grevillea UCH",                    mac: "E8:DB:84:F3:32:5F", lat: -32.7438291, lon: -70.7293615 },
  { id: "castillo-colores", name: "Jardín Castillo de Colores UCH",   mac: "8C:BF:EA:45:65:3C", lat: -32.7398587, lon: -70.7103370 },
  { id: "sf-real-iii",      name: "Condominio San Felipe el Real III", mac: "38:44:BE:92:C9:F0", lat: -32.7580595, lon: -70.7226825 },
];

// ---------- utilidades ----------
const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function localParts(tsSec) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(tsSec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
function todayLocal() { return localParts(Date.now() / 1000).date; }
function shiftDate(d, days) {
  const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

async function ecowitt(path, params, env) {
  const u = new URL(`${API}/${path}`);
  u.search = new URLSearchParams({
    application_key: env.ECOWITT_APP_KEY,
    api_key: env.ECOWITT_API_KEY,
    temp_unitid: "1", // °C
    ...params,
  }).toString();
  const r = await fetch(u.toString());
  const j = await r.json();
  if (j.code !== 0) throw new Error(`Ecowitt ${path} (${params.mac}): ${j.code} ${j.msg}`);
  return j.data;
}

// Caché en memoria por instancia (la Cache API no funciona en *.workers.dev).
const MEM = new Map();
async function cached(key, ttlSec, fn) {
  const hit = MEM.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  MEM.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  return val;
}

// ---------- /now ----------
async function getNow(env) {
  const out = [];
  for (const s of STATIONS) {
    const base = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, alt: s.alt ?? null };
    try {
      const d = await ecowitt("real_time", { mac: s.mac, call_back: "outdoor" }, env);
      const o = (d && d.outdoor) || {};
      const ts = num(o.temperature?.time) ?? num(o.humidity?.time);
      out.push({ ...base, ts, t: num(o.temperature?.value), rh: num(o.humidity?.value) });
    } catch (e) {
      out.push({ ...base, ts: null, t: null, rh: null, error: String(e.message || e) });
    }
    await sleep(150); // ser amables con el límite de frecuencia de Ecowitt
  }
  return { generated: Math.floor(Date.now() / 1000), stations: out };
}

// ---------- /day ----------
function parseHistory(d) {
  const o = (d && d.outdoor) || {};
  const tl = o.temperature?.list || {};
  const hl = o.humidity?.list || {};
  const keys = new Set([...Object.keys(tl), ...Object.keys(hl)]);
  return [...keys].map(Number).sort((a, b) => a - b)
    .map((ts) => [ts, num(tl[ts]), num(hl[ts])]);
}

async function getDay(date, env) {
  const out = [];
  for (const s of STATIONS) {
    const base = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, alt: s.alt ?? null };
    try {
      // Ventana amplia (cubre la ambigüedad de zona horaria del servidor); luego se filtra al día local.
      let d;
      try {
        d = await ecowitt("history", {
          mac: s.mac, cycle_type: "5min", call_back: "outdoor",
          start_date: `${shiftDate(date, -1)} 21:00:00`, end_date: `${shiftDate(date, 1)} 03:00:00`,
        }, env);
      } catch {
        d = await ecowitt("history", {
          mac: s.mac, cycle_type: "5min", call_back: "outdoor",
          start_date: `${date} 00:00:00`, end_date: `${date} 23:59:59`,
        }, env);
      }
      // Se conserva el día local + el primer dato del día siguiente (para las 24 h).
      const next = shiftDate(date, 1);
      const series = parseHistory(d).filter(([ts]) => {
        const p = localParts(ts);
        return p.date === date || (p.date === next && p.hour === 0 && p.minute <= 10);
      });
      out.push({ ...base, series });
    } catch (e) {
      out.push({ ...base, series: [], error: String(e.message || e) });
    }
    await sleep(150);
  }
  return { date, tz: TZ, stations: out };
}

// ---------- router ----------
function json(body, env, maxAge = 60, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, env, 0);
    if (!env.ECOWITT_APP_KEY || !env.ECOWITT_API_KEY)
      return json({ error: "Faltan los secretos ECOWITT_APP_KEY / ECOWITT_API_KEY" }, env, 0, 500);
    try {
      if (url.pathname === "/stations")
        return json(STATIONS.map(({ mac, ...s }) => s), env, 3600);

      if (url.pathname === "/now")
        return json(await cached("now", 60, () => getNow(env)), env, 60);

      if (url.pathname === "/day") {
        const date = url.searchParams.get("date") || todayLocal();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date debe ser AAAA-MM-DD" }, env, 0, 400);
        const isPast = date < todayLocal();
        const ttl = isPast ? 6 * 3600 : 300;
        return json(await cached(`day:${date}`, ttl, () => getDay(date, env)), env, ttl);
      }
      return json({ endpoints: ["/now", "/day?date=AAAA-MM-DD", "/stations"] }, env, 3600);
    } catch (e) {
      return json({ error: String(e.message || e) }, env, 0, 502);
    }
  },
};

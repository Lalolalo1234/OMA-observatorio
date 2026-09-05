/**
 * OMA Observatorio — API proxy
 * ------------------------------------------------------------
 * Expone dos endpoints en vivo para el sitio estático de OMA:
 *
 *   GET /api/prices  → cotizaciones (scrapea la página SSR de
 *                       Panorama Minero: /es/markets/metals)
 *   GET /api/news    → últimos titulares (lee panorama-minero.com/llms.txt,
 *                       el índice que ellos mismos publican para agentes)
 *
 * Corre en Cloudflare Workers (free tier). No necesita KV ni base de
 * datos: usa la Cache API de Cloudflare para no pedirle datos a
 * Panorama Minero en cada visita al sitio (ver PRICES_CACHE_SECONDS /
 * NEWS_CACHE_SECONDS en wrangler.toml).
 *
 * Si el scraping falla (Panorama Minero cambia su HTML, está caído,
 * etc.) cada endpoint devuelve un fallback estático embebido acá
 * mismo, con "degraded: true", para que el sitio nunca se rompa.
 */

const METALS_URL = 'https://www.panorama-minero.com/es/markets/metals';
const LLMS_URL = 'https://www.panorama-minero.com/llms.txt';

// Tickers de Panorama Minero que nos interesan, y cómo se muestran en el ticker.
const TARGET_TICKERS = {
  'HG00': 'Cobre',
  'LI': 'Litio',
  'LITH-CAR': 'Carbonato de Litio',
  'XAU': 'Oro',
  'XAG': 'Plata',
  'ZNC': 'Zinc',
  'TIN': 'Estaño'
};

// Minerales que Panorama Minero no cotiza (todavía) — valores de referencia,
// actualizar a mano acá hasta encontrar una fuente en vivo.
const MANUAL_EXTRA_PRICES = [
  { name: 'Tierras Raras (NdPr)', price: '68,5', unit: 'USD/kg', changePct: 0.8, direction: 'up', manual: true },
  { name: 'Manganeso (mineral 44% Mn)', price: '4,35', unit: 'USD/dmtu', changePct: -0.5, direction: 'down', manual: true }
];

const FALLBACK_PRICES = [
  { name: 'Cobre', price: '6,67', unit: 'USD/lb', changePct: 0.05, direction: 'up' },
  { name: 'Litio (carbonato, China)', price: '11.200', unit: 'USD/t', changePct: 1.2, direction: 'up' },
  { name: 'Tierras Raras (NdPr)', price: '68,5', unit: 'USD/kg', changePct: 0.8, direction: 'up' },
  { name: 'Oro', price: '4.477,20', unit: 'USD/oz', changePct: -1.38, direction: 'down' },
  { name: 'Plata', price: '66,82', unit: 'USD/oz', changePct: -1.31, direction: 'down' },
  { name: 'Zinc', price: '3.927,75', unit: 'USD/t', changePct: 0.92, direction: 'up' },
  { name: 'Estaño', price: '54.622', unit: 'USD/t', changePct: 1.39, direction: 'up' },
  { name: 'Manganeso (mineral 44% Mn)', price: '4,35', unit: 'USD/dmtu', changePct: -0.5, direction: 'down' }
];

const FALLBACK_NEWS = [
  { title: 'La demanda de talento para la minería y la capacidad de respuesta del sistema de formación', url: 'https://www.panorama-minero.com/es/news/la-demanda-de-talento-para-la-mineria-y-la-capacidad-de-respuesta-del-sistema-de-formacion' },
  { title: 'Prevención y seguridad ante el arco eléctrico: San Juan frente al crecimiento de la demanda energética industrial y minera impulsado por grandes proyectos', url: 'https://www.panorama-minero.com/es/news/prevencion-y-seguridad-ante-el-arco-electrico-san-juan-frente-al-crecimiento-de-la-demanda-energetica-industrial-y-minera-impulsado-por-grandes-proyectos' },
  { title: 'Diesel 10 Minero: la nueva apuesta de YPF para responder a los desafíos energéticos de la minería', url: 'https://www.panorama-minero.com/es/news/diesel-10-minero-la-nueva-apuesta-de-ypf-para-responder-a-los-desafios-energeticos-de-la-mineria' },
  { title: 'Kachi completó la audiencia pública y avanza hacia la definición de su Declaración de Impacto Ambiental', url: 'https://www.panorama-minero.com/es/news/kachi-completo-la-audiencia-publica-y-avanza-hacia-la-definicion-de-su-declaracion-de-impacto-ambiental' },
  { title: 'Tras décadas de atraso en infraestructura, la Ruta Nacional 7 entra en una nueva etapa', url: 'https://www.panorama-minero.com/es/news/tras-decadas-de-atraso-en-infraestructura-la-ruta-nacional-7-entra-en-una-nueva-etapa' }
];

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data, env, maxAgeSeconds) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAgeSeconds}`,
      ...corsHeaders(env)
    }
  });
}

/** Parsea la tabla SSR de /es/markets/metals sin necesitar un navegador headless. */
function parseMetalsHtml(html) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const parsed = [];

  for (const row of rows) {
    if (!row.includes('ticker') || !row.includes('variationPill')) continue;

    const nameMatch = row.match(/title="([^"]+)"/);
    const tickerMatch = row.match(/class="[^"]*ticker[^"]*"[^>]*>([^<]+)</);
    const priceMatch = row.match(/priceWrap[^"]*"[^>]*><span>([^<]+)<\/span><span[^>]*priceUnit[^"]*"[^>]*>\/(?:<!--\s*-->)?([^<]*)<\/span>/);
    if (!nameMatch || !tickerMatch || !priceMatch) continue;

    const variations = [...row.matchAll(/variationPill[^"]*?(bg-success|bg-danger)[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>([^<]+)<\/span>/g)]
      .map(m => ({ direction: m[1] === 'bg-danger' ? 'down' : 'up', value: m[2] }));

    // Orden observado en la página: 1h%, 24h%, 7d%. Usamos 24h (índice 1) si está.
    const change = variations[1] || variations[0] || { direction: 'up', value: '0.00%' };

    parsed.push({
      ticker: tickerMatch[1].trim(),
      name: nameMatch[1].trim(),
      price: priceMatch[1].trim(),
      unit: priceMatch[2].trim(),
      changePct: parseFloat(change.value.replace('%', '').replace(',', '.')) || 0,
      direction: change.direction
    });
  }

  return parsed;
}

function parseLlmsNews(text, limit) {
  const section = text.split('## Noticias recientes (Español)')[1];
  if (!section) return [];
  const block = section.split(/\n##\s/)[0];
  const items = [...block.matchAll(/-\s*\[(.+?)\]\((https?:\/\/[^\)]+)\)/g)]
    .map(m => ({ title: m[1].trim(), url: m[2].trim() }));
  return items.slice(0, limit);
}

async function handlePrices(env, ctx) {
  try {
    const res = await fetch(METALS_URL, {
      headers: { 'User-Agent': 'OMA-Observatorio-Bot/1.0 (+https://github.com/Lalolalo1234/OMA-observatorio)' }
    });
    if (!res.ok) throw new Error(`Panorama Minero respondió ${res.status}`);
    const html = await res.text();
    const scraped = parseMetalsHtml(html);

    const items = Object.entries(TARGET_TICKERS)
      .map(([ticker, displayName]) => {
        const found = scraped.find(r => r.ticker === ticker);
        if (!found) return null;
        return { ...found, name: displayName };
      })
      .filter(Boolean);

    if (items.length < 4) {
      // El scraping trajo muy poco — probablemente cambió el HTML de origen.
      return jsonResponse(
        { updated: new Date().toISOString(), source: 'fallback', degraded: true, items: FALLBACK_PRICES },
        env,
        60 // cachear poco tiempo el fallback, para reintentar pronto
      );
    }

    return jsonResponse(
      {
        updated: new Date().toISOString(),
        source: METALS_URL,
        degraded: false,
        items: [...items, ...MANUAL_EXTRA_PRICES]
      },
      env,
      Number(env.PRICES_CACHE_SECONDS || 600)
    );
  } catch (err) {
    return jsonResponse(
      { updated: new Date().toISOString(), source: 'fallback', degraded: true, error: String(err), items: FALLBACK_PRICES },
      env,
      60
    );
  }
}

async function handleNews(env, ctx) {
  try {
    const res = await fetch(LLMS_URL, {
      headers: { 'User-Agent': 'OMA-Observatorio-Bot/1.0 (+https://github.com/Lalolalo1234/OMA-observatorio)' }
    });
    if (!res.ok) throw new Error(`Panorama Minero respondió ${res.status}`);
    const text = await res.text();
    const items = parseLlmsNews(text, 6);

    if (items.length < 3) {
      return jsonResponse(
        { updated: new Date().toISOString(), source: 'fallback', degraded: true, items: FALLBACK_NEWS },
        env,
        60
      );
    }

    return jsonResponse(
      { updated: new Date().toISOString(), source: LLMS_URL, degraded: false, items },
      env,
      Number(env.NEWS_CACHE_SECONDS || 900)
    );
  } catch (err) {
    return jsonResponse(
      { updated: new Date().toISOString(), source: 'fallback', degraded: true, error: String(err), items: FALLBACK_NEWS },
      env,
      60
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // Cache de borde de Cloudflare, además del Cache-Control que ya viaja
    // en la respuesta — evita pegarle a Panorama Minero en cada visita.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    let response;
    if (url.pathname === '/api/prices') {
      response = await handlePrices(env, ctx);
    } else if (url.pathname === '/api/news') {
      response = await handleNews(env, ctx);
    } else {
      response = new Response('OMA Observatorio API — ver /api/prices y /api/news', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(env) }
      });
    }

    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }
};

# OMA Observatorio — API en vivo (cotizaciones y noticias)

Este mini-backend le da al sitio (`index.html`) datos en vivo en vez de los
valores estáticos que tiene hoy. Corre gratis en **Cloudflare Workers**
(free tier: 100.000 requests/día, de sobra para este sitio).

## Qué hace

- **`GET /api/prices`** — lee la página de cotizaciones que Panorama Minero
  ya publica en `https://www.panorama-minero.com/es/markets/metals`
  (viene renderizada en el HTML, no hace falta login ni clave) y devuelve
  Cobre, Litio, Carbonato de Litio, Oro, Plata, Zinc y Estaño en JSON.
  Tierras Raras y Manganeso —que Panorama Minero no cotiza— se agregan
  como valores de referencia manuales (editables en `src/index.js`).
- **`GET /api/news`** — lee `https://www.panorama-minero.com/llms.txt`,
  el índice que ellos mismos publican para que agentes como este lean su
  sitio, y devuelve los últimos titulares en JSON.
- Ambos cachean la respuesta 10-15 minutos (configurable en `wrangler.toml`)
  para no pedirle datos a Panorama Minero en cada visita al sitio.
- Si el scraping falla por cualquier motivo (cambiaron su HTML, están
  caídos, etc.), cada endpoint devuelve automáticamente un fallback
  estático embebido en el propio worker — el sitio nunca se rompe.

Ya probé ambos parsers contra el HTML/texto real de Panorama Minero
(05/09/2026) y funcionan.

## Cómo desplegarlo (una sola vez, ~10 minutos)

Necesitás una cuenta gratis de Cloudflare (no puedo crearla por vos).

1. **Crear cuenta** en https://dash.cloudflare.com/sign-up (gratis, no pide
   tarjeta para el free tier de Workers).

2. **Instalar Wrangler** (la CLI de Cloudflare) si no la tenés:
   ```bash
   npm install -g wrangler
   ```

3. **Loguearte** (abre el navegador para autorizar):
   ```bash
   cd "/Users/admin/Desktop/OMA Observatorio/worker"
   wrangler login
   ```

4. **Desplegar**:
   ```bash
   wrangler deploy
   ```
   Esto imprime una URL tipo:
   `https://oma-observatorio-api.<tu-subdominio>.workers.dev`

5. **Conectar el sitio**: abrí `index.html`, buscá la línea

   ```js
   const OMA_API_BASE = '';
   ```

   y pegá ahí la URL que te dio `wrangler deploy` (sin la barra final):

   ```js
   const OMA_API_BASE = 'https://oma-observatorio-api.tu-subdominio.workers.dev';
   ```

   Guardá y recargá el sitio — el ticker y las noticias van a mostrar
   "En vivo vía Panorama Minero" en vez de la nota de valores de referencia.

6. **(Recomendado) Ajustar CORS**: una vez que el sitio esté publicado en
   GitHub Pages con su URL final, editá `ALLOWED_ORIGIN` en `wrangler.toml`
   para restringirlo a esa URL en vez de `"*"`, y volvé a correr
   `wrangler deploy`.

## Probarlo sin tocar el sitio

Una vez desplegado, podés abrir directamente en el navegador:
- `https://<tu-worker>.workers.dev/api/prices`
- `https://<tu-worker>.workers.dev/api/news`

y deberías ver el JSON con `"degraded": false` y los datos reales.

## Mantenimiento

- Si Panorama Minero rediseña su sitio y el scraping empieza a devolver
  `"degraded": true` de forma persistente, hay que ajustar los selectores
  en `parseMetalsHtml()` / `parseLlmsNews()` dentro de `src/index.js`.
- Los valores manuales de Tierras Raras y Manganeso (`MANUAL_EXTRA_PRICES`
  en `src/index.js`) hay que actualizarlos a mano de tanto en tanto hasta
  encontrar una fuente pública en vivo para esos dos.
- Este scraping usa una fuente pública ya pensada para ser leída por
  agentes/bots (el propio `llms.txt` de Panorama Minero invita a esto con
  instrucciones de cita), y las cotizaciones se cachean 10 min para no
  generarles carga. Igual, dado que OMA se presenta como una iniciativa
  conjunta con Panorama Minero, vale la pena comentarles que este sitio
  consume sus datos así, por si prefieren ofrecer un feed formal.

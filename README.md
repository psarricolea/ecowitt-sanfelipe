# Estaciones Ecowitt · San Felipe — web en tiempo real con isotermas

Página estática (GitHub Pages) + un Cloudflare Worker gratuito que consulta la API v3 de Ecowitt sin exponer las claves.

```
navegador ──► GitHub Pages (index.html: Leaflet + Turf, IDW + isolíneas)
                 │  fetch /now , /day?date=
                 ▼
           Cloudflare Worker (claves como secretos, caché 1–5 min)
                 │
                 ▼
           api.ecowitt.net/api/v3/device/{real_time,history}
```

No usa GitHub Actions, así que no consume minutos del plan.

## 1. Claves de Ecowitt (no es su contraseña)

En **ecowitt.net** → menú de usuario → **Private Center** (Centro privado):

- **Create Application Key**: copie la *Application Key*.
- **Create API Key**: copie la *API Key*.

Las 8 MAC ya están en `worker/worker.js` (arreglo `STATIONS`). Si agrega estaciones, súmelas ahí con su MAC, lat y lon.

## 2. Publicar el Worker (≈10 min, gratis)

**Opción A: desde el navegador**
1. Cree una cuenta en dash.cloudflare.com → *Workers & Pages* → *Create* → *Create Worker* → nombre `ecowitt-sanfelipe` → *Deploy*.
2. *Edit code*: reemplace todo por el contenido de `worker/worker.js` → *Deploy*.
3. *Settings → Variables and Secrets* → *Add*:
   - `ECOWITT_APP_KEY` (tipo **Secret**)
   - `ECOWITT_API_KEY` (tipo **Secret**)
   - `ALLOWED_ORIGIN` (texto) = `https://SU-USUARIO.github.io` (opcional; por defecto `*`)
4. Pruebe en el navegador `https://ecowitt-sanfelipe.SU-SUBDOMINIO.workers.dev/now`. Debe mostrar las 8 estaciones con `t` y `rh`.

**Opción B: por terminal**
```bash
cd worker
npx wrangler login
npx wrangler secret put ECOWITT_APP_KEY
npx wrangler secret put ECOWITT_API_KEY
npx wrangler deploy
```

## 3. Publicar la página

1. En `index.html`, bloque `CONFIG`, ponga `WORKER_URL: "https://ecowitt-sanfelipe.SU-SUBDOMINIO.workers.dev"`.
2. Suba `index.html` a un repositorio (puede ser **público**: no contiene claves) → *Settings → Pages* → rama `main`, carpeta raíz.
3. Agregar `?demo` a la URL fuerza el modo demo, con datos simulados.

## Qué muestra

- **Variables:** temperatura, humedad relativa y humidex (Environment Canada, con Td de Magnus).
- **Momentos:** *Ahora* (se refresca cada 5 min), **00, 08, 12, 16, 20 h** locales y **máxima y mínima diarias** de cualquier fecha. Para las horas sinópticas toma la observación de 5 min más cercana (tolerancia ±10 min). Los extremos son de 00 a 24 h locales.
- **Isolíneas** con intervalo automático (0,25 / 0,5 / 1 / 2 °C; 1 / 2 / 5 / 10 % para HR), bandas de color opcionales y etiquetas.
- El área fuera de la envolvente convexa de las estaciones (+350 m) aparece atenuada, porque es extrapolación.
- En *Ahora*, las estaciones sin datos en los últimos 30 min se marcan **s/d** y quedan fuera de la interpolación.

## Parámetros editables (`CONFIG` en index.html)

`REFRESH_MIN`, `STALE_MIN`, `MATCH_MIN`, `IDW_POWER`, `GRID_N`.

## Notas y límites

- **IDW con 8 estaciones produce "ojos de buey"** alrededor de cada punto. Es esperable: las isolíneas describen la red, no un campo continuo. Para un campo más físico, el paso siguiente es una regresión con covariables (altitud, NDVI, LCZ) más interpolación de residuos, calculada en el Worker o en R y publicada como GeoJSON.
- **El historial de 5 min de Ecowitt tiene retención limitada** (del orden de meses). Para fechas antiguas puede no haber serie de 5 min. Su descarga a ECOWITT_DATA sigue siendo el archivo de largo plazo.
- **Formato de la API:** el Worker interpreta la respuesta como `data.outdoor.temperature.value|time` (real_time) y `data.outdoor.temperature.list{ts:valor}` (history). Si Ecowitt cambia algo, la ventana emergente de cada estación muestra el error.

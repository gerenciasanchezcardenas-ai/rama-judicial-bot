require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { consultarPorNombre, consultarPorRadicado, obtenerActuaciones } = require("./src/ramaJudicial");

const app = express();

app.use("/wompi-webhook", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY || "prv_prod_2A43U6Iijwv3eV0gCV25a2Ab7qjQNePa";
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET || "prod_events_Rm3upKCLaRYHoQki8QICIoQ6G2V9ShqA";
const WOMPI_API = "https://production.wompi.co/v1";
const COBRO_CENTAVOS = 5000000;

const sesiones = {};
const pendingPayments = {};

async function enviarMensaje(telefono, texto) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const from = TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? TWILIO_WHATSAPP_NUMBER : `whatsapp:${TWILIO_WHATSAPP_NUMBER}`;
  const to = telefono.startsWith("whatsapp:") ? telefono : `whatsapp:${telefono}`;
  console.log("Enviando mensaje Twilio - From:", from, "To:", to);
  try {
    const res = await axios.post(url,
      new URLSearchParams({ From: from, To: to, Body: texto }).toString(),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );
    console.log("Twilio OK:", res.data?.sid);
  } catch (e) {
    console.error("Twilio error:", e.response?.status, JSON.stringify(e.response?.data));
    throw e;
  }
}

async function enviarArchivo(telefono, buffer, filename, caption) {
  try {
    const tmpDir = path.join(__dirname, "tmp_pdfs");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, filename);
    fs.writeFileSync(tmpFile, buffer);
    const fileUrl = `https://rama-judicial-bot.onrender.com/pdf/${encodeURIComponent(filename)}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const from = TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? TWILIO_WHATSAPP_NUMBER : `whatsapp:${TWILIO_WHATSAPP_NUMBER}`;
    const to = telefono.startsWith("whatsapp:") ? telefono : `whatsapp:${telefono}`;
    await axios.post(url,
      new URLSearchParams({ From: from, To: to, Body: caption || filename, MediaUrl: fileUrl }).toString(),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch(e) {} }, 5 * 60 * 1000);
  } catch (e) {
    console.error("Error enviando archivo:", e.response?.data || e.message);
    await enviarMensaje(telefono, caption || filename);
  }
}

function tieneMicrositio(act) {
  if (!act) return false;
  const tip = (act.actuacion || "").toLowerCase();
  // Hay documento publicado en el micrositio para "Fijacion estado" Y "Notificacion por Estado"
  return tip.includes("fijacion estado") || tip.includes("fijación estado")
      || tip.includes("notificacion por estado") || tip.includes("notificación por estado");
}

function parsearRadicado(radicado) {
  // 23 dígitos: DD MMM TT EE NNN AAAA CCCCC II
  // pos 0-1: departamento (DANE)
  // pos 2-4: municipio
  // pos 5-6: tipo entidad
  // pos 7-8: especialidad
  // pos 9-11: número despacho (3 dígitos)
  // pos 12-15: año
  // pos 16-20: consecutivo
  // pos 21-22: instancia
  const r = (radicado || "").replace(/\s/g, "");
  if (r.length < 21) return null;
  const dep    = r.substring(0, 2);
  const mun    = r.substring(2, 5);
  const tipo   = r.substring(5, 7);
  const esp    = r.substring(7, 9);
  const num    = r.substring(9, 12);
  const year   = r.substring(12, 16);
  const consec = r.substring(16, 21);
  // El value del Despacho en el micrositio = dep + mun + tipo + esp + num (12 chars)
  const despachoCod = dep + mun + tipo + esp + num;
  return { dep, mun, tipo, esp, num, year, consec, despachoCod };
}

function micrositioUrl(radicado, idRegActuacion) {
  // URL de búsqueda pre-rellenada con el radicado — lleva directamente a los resultados del proceso
  const BASE = "https://publicacionesprocesales.ramajudicial.gov.co";
  const PORTLET = "co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq";
  const r = (radicado || "").replace(/\s/g, "");
  // Rango de fechas amplio: 30 días antes y 30 días después de hoy
  const hoy = new Date();
  const fIni = new Date(hoy); fIni.setDate(hoy.getDate() - 30);
  const fFin = new Date(hoy); fFin.setDate(hoy.getDate() + 5);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  // URL con parámetros de búsqueda en el portlet (lifecycle=0 render con filtros pre-cargados)
  return `${BASE}/web/publicaciones-procesales/inicio?p_p_id=${PORTLET}&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&_${PORTLET}_radicado=${r}&_${PORTLET}_fechaInicio=${fmt(fIni)}&_${PORTLET}_fechaFin=${fmt(fFin)}`;
}

async function crearLinkPago(referencia, descripcion) {
  try {
    const res = await axios.post(`${WOMPI_API}/payment_links`,
      { name: descripcion, description: "Documento proceso judicial – Sánchez & Cárdenas",
        single_use: true, collect_shipping: false, currency: "COP",
        amount_in_cents: COBRO_CENTAVOS, redirect_url: "https://sanchezcardenasconsulting.com",
        reference: referencia },
      { headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data?.data?.url || null;
  } catch (e) {
    console.error("Error creando link Wompi:", e.response?.data || e.message);
    return null;
  }
}

async function enviarPorCorreo(destinatario, asunto, cuerpo, adjunto) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurado");
  const payload = {
    from: "Sánchez & Cárdenas <notificaciones@sanchezcardenasconsulting.com>",
    to: [destinatario],
    subject: asunto,
    html: cuerpo,
  };
  if (adjunto) {
    payload.attachments = [{
      filename: adjunto.filename,
      content: adjunto.buffer.toString("base64"),
    }];
  }
  const res = await axios.post("https://api.resend.com/emails", payload, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    timeout: 30000,
  });
  console.log("Resend OK:", res.data?.id);
  return res.data;
}

// Obtiene el documento PDF del micrositio de publicaciones procesales
// usando Puppeteer (browser headless) para evitar el bloqueo 403 que el portal aplica a servidores.
// Flujo: Puppeteer abre el micrositio → cascade de filtros → BUSCAR → captura articleId → descarga PDF
// Retorna { tipo, data, ext } o null si falla.
async function capturarScreenshotMicrositio(radicado, idRegActuacion, fechaActuacion) {
  const BASE = "https://publicacionesprocesales.ramajudicial.gov.co";
  const GROUP_ID = "6098902";
  const PORTLET = "co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq";
  const P = `_${PORTLET}`;
  // URL real confirmada por captura de Network:
  // GET /web/publicaciones-procesales/inicio?p_p_id=...&_..._action=busqueda
  //   &_..._fechaInicio=2026-10-01&_..._fechaFin=2026-10-19
  //   &_..._idDepto=11&_..._idMuni=11001&_..._idEntidad=40
  //   &_..._idEspecialidad=03&_..._idDespacho=110014003028
  //
  // Estructura del radicado (23 dígitos): DDMMMTTEENNNAAAAA CCCCCC II
  //   pos 0-1:  idDepto   (11 = Bogotá)
  //   pos 0-4:  idMuni    (11001 = Bogotá D.C.)
  //   pos 5-6:  idEntidad (40 = Juzgado Municipal, 03 = Juzgado Circuito, 01 = Tribunal)
  //   pos 7-8:  idEspecialidad (01=Civil Circuito, 03=Civil Municipal…)
  //   pos 0-11: idDespacho (12 dígitos: dep+mun+entidad+esp+num)
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
  };

  // Portal bloquea requests axios con 403. Usar Puppeteer (browser headless) para evitarlo.
  let browser;
  try {
    const r = (radicado || "").replace(/\s/g, "");
    if (r.length < 20) { console.error("[micrositio] radicado inválido:", radicado); return null; }

    // Extraer componentes del radicado (23 dígitos) — igual que parsearRadicado()
    // 11  001  40  03  028  2023  00068  200
    // dep mun  tip esp  num  año  consec  inst
    const idDepto        = r.substring(0, 2);   // "11"
    const idMuni         = r.substring(0, 5);   // "11001" ← 5 chars: dep+mun (el select usa código completo)
    const idEntidad      = r.substring(5, 7);   // "40"
    const idEspecialidad = r.substring(7, 9);   // "03"
    const idNum          = r.substring(9, 12);  // "028"
    const idDespacho     = idDepto + r.substring(2,5) + idEntidad + idEspecialidad + idNum; // "110014003028"
    const anioRad        = r.substring(12, 16); // "2023"
    const consecRad      = r.substring(16, 21); // "00068"
    const consecInt      = String(parseInt(consecRad, 10)); // "68"

    const fFin    = new Date();
    const fInicio = new Date(); fInicio.setDate(fInicio.getDate() - 60);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    console.log(`[micrositio] radicado=${r} despacho=${idDespacho} rango=${fmt(fInicio)}→${fmt(fFin)}`);

    // ── Lanzar Puppeteer ──
    const puppeteer = require("puppeteer");
    const fs2 = require("fs");
    const { execSync } = require("child_process");

    // Buscar Chrome instalado por puppeteer en rutas conocidas de Render
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer";
    let foundExec = null;

    // 1. Intentar puppeteer.executablePath() — funciona si PUPPETEER_CACHE_DIR está bien
    try {
      const ep = puppeteer.executablePath();
      if (ep && fs2.existsSync(ep)) { foundExec = ep; console.log(`[micrositio] Chrome vía executablePath: ${ep}`); }
      else console.log(`[micrositio] executablePath()=${ep} pero no existe`);
    } catch(e) { console.log(`[micrositio] executablePath() error: ${e.message}`); }

    // 2. Buscar glob en el cacheDir
    if (!foundExec) {
      try {
        const hits = execSync(`find ${cacheDir} -name "chrome" -o -name "chromium" -o -name "chrome-linux" 2>/dev/null | head -5`, { encoding: "utf8" }).trim();
        console.log(`[micrositio] find chrome en ${cacheDir}: ${hits || "nada"}`);
        const lines = hits.split("\n").filter(Boolean);
        for (const line of lines) {
          if (fs2.existsSync(line) && !line.endsWith(".json")) {
            // Verificar que es ejecutable
            try { execSync(`test -x "${line}"`); foundExec = line; break; } catch(_) {}
          }
        }
        if (!foundExec && lines.length > 0) {
          // Buscar ejecutable dentro del directorio encontrado
          for (const line of lines) {
            const dir = line.endsWith("/chrome") || line.endsWith("/chromium") ? require("path").dirname(line) : line;
            const exec2 = execSync(`find "${dir}" -maxdepth 2 -type f -name "chrome" -o -name "chromium" 2>/dev/null | head -3`, { encoding: "utf8" }).trim();
            const execs = exec2.split("\n").filter(Boolean);
            for (const e2 of execs) { try { execSync(`test -x "${e2}"`); foundExec = e2; break; } catch(_) {} }
            if (foundExec) break;
          }
        }
      } catch(e) { console.log(`[micrositio] find error: ${e.message}`); }
    }

    // 3. Si no se encontró, instalar ahora mismo
    if (!foundExec) {
      console.log(`[micrositio] Chrome no encontrado, instalando en tiempo de ejecución...`);
      try {
        execSync(`npx puppeteer browsers install chrome`, { encoding: "utf8", stdio: "inherit", env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir } });
        try { const ep = puppeteer.executablePath(); if (ep && fs2.existsSync(ep)) foundExec = ep; } catch(_) {}
      } catch(e) { console.log(`[micrositio] Error instalando Chrome: ${e.message}`); }
    }

    console.log(`[micrositio] executablePath final: ${foundExec || "default (puede fallar)"}`);

    const launchOpts = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
    };
    if (foundExec) launchOpts.executablePath = foundExec;

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // Interceptar requests para capturar PDF cuando aparezca
    let pdfUrlCapturada = null;
    let articleIdCapturado = null;
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url.includes('get_file') && url.includes('uuid=')) {
        pdfUrlCapturada = url;
        console.log(`[micrositio] PDF URL interceptada: ${url}`);
      }
      if (url.includes('articleId=')) {
        const m = /articleId=(\d{6,12})/.exec(url);
        if (m) articleIdCapturado = m[1];
      }
      req.continue();
    });

    // ── PASO 1: Navegar al micrositio ──
    console.log(`[micrositio] Navegando al micrositio...`);
    await page.goto(`${BASE}/web/publicaciones-procesales/inicio`, {
      waitUntil: "domcontentloaded", timeout: 90000
    });
    // Esperar a que los selects se inicialicen (el portal es lento)
    console.log(`[micrositio] Esperando que los selects inicialicen...`);
    for (let i = 0; i < 20; i++) {
      await new Promise(res => setTimeout(res, 2000));
      const count = await page.evaluate(() => {
        const sel = document.getElementById('departamento') || document.querySelector('select');
        return sel ? sel.options.length : -1;
      });
      console.log(`[micrositio] poll ${i+1}: select departamento tiene ${count} opciones`);
      if (count > 1) break;
    }

    // Helper para seleccionar valor en un select con jQuery/native
    const selectFiltro = async (selectId, value, label) => {
      await new Promise(res => setTimeout(res, 2000));
      const res = await page.evaluate((selId, val) => {
        const sel = document.getElementById(selId);
        if (!sel) return `no #${selId}`;
        const opt = Array.from(sel.options).find(o => o.value.trim() === val || o.value.trim() === " " + val);
        if (!opt) return `val="${val}" no encontrado en #${selId} (${sel.options.length} opts)`;
        const realVal = opt.value;
        if (typeof jQuery !== 'undefined') {
          jQuery('#' + selId).val(realVal).trigger('change');
          return `ok-jq #${selId}="${realVal}"`;
        }
        sel.value = realVal;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return `ok-native #${selId}="${realVal}"`;
      }, selectId, value);
      console.log(`[micrositio] ${label}: ${res}`);
      return res.startsWith('ok');
    };

    // ── PASO 2: Cascade de filtros ──
    await selectFiltro('departamento', idDepto, `Departamento=${idDepto}`);
    await new Promise(res => setTimeout(res, 3000)); // esperar que cargue municipios
    await selectFiltro('municipio', idMuni, `Municipio=${idMuni}`);
    await new Promise(res => setTimeout(res, 3000)); // esperar que cargue entidades
    await selectFiltro('entidad', idEntidad, `Entidad=${idEntidad}`);
    await new Promise(res => setTimeout(res, 3000)); // esperar que cargue especialidades
    // Especialidad viene del radicado (pos 7-8): "03" = Civil Municipal
    await selectFiltro('especialidad', idEspecialidad, `Especialidad=${idEspecialidad}`);
    await new Promise(res => setTimeout(res, 3000)); // esperar que cargue despachos
    await selectFiltro('despacho', idDespacho, `Despacho=${idDespacho}`);
    await new Promise(res => setTimeout(res, 2000));

    // ── PASO 3: Poner fechas (últimos 60 días) ──
    const fechaInicio = fmt(fInicio);
    const fechaFin    = fmt(fFin);
    await page.evaluate((fi, ff) => {
      const inputs = document.querySelectorAll('input[type="date"]');
      if (inputs[0]) { inputs[0].value = fi; inputs[0].dispatchEvent(new Event('change', { bubbles: true })); }
      if (inputs[1]) { inputs[1].value = ff; inputs[1].dispatchEvent(new Event('change', { bubbles: true })); }
      return `${inputs.length} inputs → ${fi} a ${ff}`;
    }, fechaInicio, fechaFin);
    console.log(`[micrositio] Fechas: ${fechaInicio} → ${fechaFin}`);

    // ── PASO 4: Clic BUSCAR — el portal usa AJAX, no navegación de página ──
    console.log(`[micrositio] Haciendo clic en BUSCAR...`);
    await page.evaluate(() => {
      const btn = document.getElementById('buscar') ||
                  document.querySelector('button[type="submit"], input[type="submit"], .buscar, [class*="buscar"]');
      if (btn) btn.click();
    });
    // El portal carga resultados vía AJAX — esperar que aparezca el contenido de resultados
    console.log(`[micrositio] Esperando resultados AJAX (el portal es lento)...`);
    // Intentar esperar un elemento típico de resultados; si no aparece en 20s, continuar igual
    try {
      await page.waitForFunction(() => {
        // Buscar cualquier link con articleId en el DOM (indica que cargaron resultados)
        const links = document.querySelectorAll('a[href*="articleId"]');
        return links.length > 0;
      }, { timeout: 20000 });
      console.log(`[micrositio] Resultados AJAX detectados`);
    } catch(e) {
      console.log(`[micrositio] waitForFunction timeout, continuando con lo que haya`);
      await new Promise(res => setTimeout(res, 5000));
    }

    // ── PASO 5: Extraer articleIds del HTML de resultados ──
    // Leer solo el portlet de resultados para evitar articleIds de la navegación general
    const htmlBusq = await page.evaluate(() => {
      // Intentar leer solo el contenedor del portlet de resultados
      const portlet = document.querySelector('[id*="PublicacionesEfectosProcesalesPortlet"]') ||
                      document.querySelector('.portlet-body') ||
                      document.querySelector('#main-content') ||
                      document.body;
      return portlet.innerHTML;
    });
    const reArt = /articleId[=\s:"']+(\d{6,12})/gi;
    let ma;
    const articleIds = [];
    while ((ma = reArt.exec(htmlBusq)) !== null) {
      if (!articleIds.includes(ma[1])) articleIds.push(ma[1]);
    }
    console.log(`[micrositio] articleIds encontrados: ${articleIds.join(", ") || "ninguno"}`);

    // Tokens para identificar el radicado correcto entre varios resultados
    const tokensEnBusq = [
      r,
      anioRad + consecRad,
      anioRad + "0" + consecInt,
      anioRad + "00" + consecInt,
      anioRad + consecInt,
    ];

    let articleId = articleIdCapturado || null;

    if (!articleId) {
      for (const aid of articleIds) {
        const idx = htmlBusq.indexOf(`articleId=${aid}`);
        if (idx === -1) continue;
        const contexto = htmlBusq.substring(Math.max(0, idx - 800), idx + 800);
        for (const token of tokensEnBusq) {
          if (token && contexto.includes(token)) {
            articleId = aid;
            console.log(`[micrositio] articleId=${aid} por token="${token}"`);
            break;
          }
        }
        if (articleId) break;
      }
    }

    // Si hay un único resultado, tomarlo directamente
    if (!articleId && articleIds.length === 1) {
      articleId = articleIds[0];
      console.log(`[micrositio] Un solo articleId=${articleId}, usando directamente`);
    }

    if (!articleId) {
      console.log(`[micrositio] Sin articleId. HTML[0-1500]: ${htmlBusq.substring(0, 1500)}`);
      await browser.close();
      return null;
    }

    // ── PASO 6: Clic en "Ver detalle" del artículo ──
    console.log(`[micrositio] Abriendo detalle articleId=${articleId}...`);
    const clickedDetail = await page.evaluate((aid) => {
      const links = Array.from(document.querySelectorAll(`a[href*="articleId=${aid}"], a[href*="articleId%3D${aid}"]`));
      if (links.length > 0) { links[0].click(); return `clic en link articleId=${aid}`; }
      // Buscar por texto del botón "Ver"
      const allLinks = Array.from(document.querySelectorAll('a'));
      const verLink = allLinks.find(a => a.href && a.href.includes(aid));
      if (verLink) { verLink.click(); return `clic en link que contiene ${aid}`; }
      return 'no encontrado';
    }, articleId);
    console.log(`[micrositio] Detalle: ${clickedDetail}`);

    if (clickedDetail !== 'no encontrado') {
      await new Promise(res => setTimeout(res, 8000));
    }

    // ── PASO 7: Extraer UUID del PDF del HTML de detalle ──
    const htmlDetalle = await page.evaluate(() => document.body.innerHTML);
    const uuidPatterns = [
      /uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&groupId=(\d+)/i,
      /get_file\?uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    ];
    let uuid = null, groupId = GROUP_ID;
    for (const pat of uuidPatterns) {
      const mu = pat.exec(htmlDetalle) || pat.exec(htmlBusq);
      if (mu) { uuid = mu[1]; if (mu[2]) groupId = mu[2]; break; }
    }

    if (!uuid && pdfUrlCapturada) {
      // Extraer UUID de la URL interceptada
      const mu = /uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(pdfUrlCapturada);
      if (mu) { uuid = mu[1]; }
      const mg = /groupId=(\d+)/.exec(pdfUrlCapturada);
      if (mg) groupId = mg[1];
    }

    if (!uuid) {
      console.log(`[micrositio] UUID no encontrado. Detalle[0-800]: ${htmlDetalle.substring(0, 800)}`);
      await browser.close();
      return null;
    }

    // ── PASO 8: Descargar PDF usando cookies de la sesión Puppeteer ──
    const pdfUrl = `${BASE}/c/document_library/get_file?uuid=${uuid}&groupId=${groupId}`;
    console.log(`[micrositio] Descargando PDF: ${pdfUrl}`);

    // Usar page.evaluate + fetch para descargar el PDF con las cookies de sesión activas
    // (no se puede usar axios porque el portal bloquea con 403 desde el servidor)
    const pdfArr = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const ab = await resp.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
      } catch (e) {
        return { error: e.message };
      }
    }, pdfUrl);

    await browser.close();

    if (pdfArr.error) {
      console.log(`[micrositio] Error descargando PDF: ${pdfArr.error}`);
      return null;
    }

    const pdfBuffer = Buffer.from(pdfArr.data);
    console.log(`[micrositio] PDF OK bytes=${pdfBuffer.length}`);

    if (pdfBuffer.length < 500) {
      console.log(`[micrositio] Respuesta muy pequeña (posible HTML de error)`);
      return null;
    }

    return { tipo: "pdf", data: pdfBuffer, ext: "pdf" };

  } catch (e) {
    if (browser) try { await browser.close(); } catch(_) {}
    console.error(`[micrositio] Error general:`, e.message);
    return null;
  }
}

// FUNCIÓN ANTIGUA CON PUPPETEER — ya no se usa, reemplazada por la de arriba
async function capturarScreenshotMicrositioPuppeteer(radicado, idRegActuacion, fechaActuacion) {
  let browser;
  try {
    const puppeteer = require("puppeteer");
    const parsed = parsearRadicado(radicado);
    if (!parsed) {
      console.error("capturarScreenshotMicrositio: radicado inválido:", radicado);
      return null;
    }
    const { despachoCod, year, consec } = parsed;
    console.log("Micrositio - radicado:", radicado, "| despachoCod:", despachoCod, "| idRegActuacion:", idRegActuacion);

    // Usar la ruta que puppeteer instaló durante postinstall (npx puppeteer browsers install chrome)
    const fs2 = require("fs");
    let puppeteerExec;
    try { puppeteerExec = puppeteer.executablePath(); } catch(_) { puppeteerExec = null; }
    // Fallback: rutas del sistema
    const { execSync } = require("child_process");
    let sysExec;
    try { sysExec = execSync("which chromium-browser || which chromium || which google-chrome || which google-chrome-stable", { encoding: "utf8" }).trim().split("\n")[0]; } catch(_) { sysExec = null; }
    const candidates = [puppeteerExec, sysExec, "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"].filter(Boolean);
    const foundExec = candidates.find(p => { try { return fs2.existsSync(p); } catch(_) { return false; } });
    console.log("Puppeteer executablePath:", puppeteerExec, "| found:", foundExec);

    const launchOpts = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
    };
    if (foundExec) launchOpts.executablePath = foundExec;

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // 1. Navegar al micrositio
    console.log("Navegando al micrositio raíz...");
    await page.goto("https://publicacionesprocesales.ramajudicial.gov.co/", {
      waitUntil: "domcontentloaded", timeout: 60000
    });

    // Helper: seleccionar un valor en un select Select2 vía jQuery
    const selectJQ = async (id, value, label) => {
      await page.waitForTimeout(800);
      const res = await page.evaluate((selId, val) => {
        const sel = document.getElementById(selId);
        if (!sel) return `no #${selId}`;
        const opts = Array.from(sel.options);
        const opt = opts.find(o => o.value.trim() === val);
        if (!opt) return `value "${val}" no encontrado en #${selId} (${opts.length} opts, primeros: ${opts.slice(1,4).map(o=>o.value.trim()).join('|')})`;
        const realVal = opt.value; // puede tener espacio
        if (typeof jQuery !== 'undefined') {
          jQuery('#' + selId).val(realVal).trigger('change');
          return `ok-jq #${selId}="${realVal}"`;
        }
        sel.value = realVal;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return `ok-native #${selId}="${realVal}"`;
      }, id, value);
      console.log(`  ${label}: ${res}`);
      return res.startsWith('ok');
    };

    // Esperar a que el primer select tenga opciones (hasta 30s)
    console.log("Esperando que los selects inicialicen...");
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const count = await page.evaluate(() => {
        const sel = document.getElementById('departamento') || document.querySelector('select');
        return sel ? sel.options.length : -1;
      });
      console.log(`  poll ${i+1}: primer select tiene ${count} opciones`);
      if (count > 1) break;
    }

    const { dep, mun, tipo, esp } = parsed;

    // Cascada: Departamento → Municipio → Entidad/Tipo → Especialidad → Despacho
    await selectJQ('departamento', dep, 'Departamento');
    await page.waitForTimeout(1500);

    await selectJQ('municipio', mun, 'Municipio');
    await page.waitForTimeout(1500);

    await selectJQ('entidad', tipo, 'Entidad/Tipo');
    await page.waitForTimeout(1500);

    await selectJQ('especialidad', esp, 'Especialidad');
    await page.waitForTimeout(1500);

    await selectJQ('despacho', despachoCod, 'Despacho');
    await page.waitForTimeout(1500);

    // Fecha exacta de la actuación "Fijacion estado"
    if (fechaActuacion) {
      try {
        const fmt = d => d.toISOString().substring(0, 10);
        const fAct = fmt(new Date(fechaActuacion));
        const fRes = await page.evaluate((fecha) => {
          const inputs = document.querySelectorAll('input[type="date"]');
          // Poner la misma fecha en inicio y fin para filtrar exactamente ese día
          if (inputs[0]) { inputs[0].value = fecha; inputs[0].dispatchEvent(new Event('change', { bubbles: true })); }
          if (inputs[1]) { inputs[1].value = fecha; inputs[1].dispatchEvent(new Event('change', { bubbles: true })); }
          return `${inputs.length} date inputs → ${fecha}`;
        }, fAct);
        console.log(`  Fecha exacta: ${fRes}`);
      } catch(e) { console.warn("Error fechas:", e.message); }
    }

    // BUSCAR
    console.log("Haciendo clic en BUSCAR...");
    const buscarOk = await page.evaluate(() => {
      const btn = document.getElementById('buscar') || document.querySelector('input[type="submit"]');
      if (btn) { btn.click(); return `clicked #${btn.id || btn.type}`; }
      return 'no encontrado';
    });
    console.log("  BUSCAR:", buscarOk);
    await page.waitForTimeout(8000);

    // Diagnóstico: texto de resultados
    const textoResultados = await page.evaluate(() => (document.body.innerText || '').substring(0, 800));
    console.log("Texto resultados:", textoResultados);

    // Buscar el proceso por radicado en la tabla de resultados
    // El radicado puede aparecer como "11001400300220230006800" o con guiones
    const radicadoLimpio = radicado.replace(/\s/g, "");
    console.log("Buscando radicado en resultados:", radicadoLimpio);

    // Encontrar la fila/card que contiene el radicado y hacer clic para abrir
    const filaEncontrada = await page.evaluate((rad) => {
      const textoNorm = t => (t || "").replace(/[\s\-]/g, "");
      // Buscar en toda la página un elemento que contenga el radicado
      const todos = Array.from(document.querySelectorAll('td, span, div, p, li'));
      for (const el of todos) {
        if (el.children.length === 0 && textoNorm(el.textContent).includes(rad)) {
          // Encontró el radicado — subir al contenedor fila/card
          const row = el.closest('tr, .card, .publicacion, article, li, .proceso');
          if (row) {
            // Buscar link o botón "ver"/"abrir" dentro de esa fila
            const link = row.querySelector('a[href], button');
            if (link) {
              link.click();
              return `click en link: ${link.href || link.textContent.trim().substring(0, 50)}`;
            }
            // Si no hay link, hacer clic en la fila directamente
            row.click();
            return `click en fila que contiene radicado`;
          }
          return `radicado encontrado pero sin link en fila`;
        }
      }
      return null;
    }, radicadoLimpio);

    console.log("Fila radicado:", filaEncontrada);
    if (filaEncontrada) await page.waitForTimeout(5000);

    // Tomar screenshot del estado abierto
    console.log("Tomando screenshot del documento/estado...");
    const screenshot = await page.screenshot({ type: "jpeg", quality: 85, fullPage: true });
    await browser.close();
    console.log("Screenshot tomado, bytes:", screenshot.length);
    return { tipo: "imagen", data: Buffer.from(screenshot), ext: "jpg" };

  } catch (e) {
    if (browser) try { await browser.close(); } catch(_) {}
    console.error("Error capturarScreenshotMicrositio:", e.message);
    return null;
  }
}

function renderActuaciones(actuaciones, radicado, despacho) {
  let msg = `📋 *Últimas actuaciones — ${radicado}*\n`;
  msg += `Despacho: ${(despacho || "N/A").substring(0, 60)}\n\n`;
  for (let i = 0; i < actuaciones.length; i++) {
    const a = actuaciones[i];
    const doc = tieneMicrositio(a) ? "📄 Con documento" : "❌ Sin documento";
    msg += `*${i + 1}.* ${a.actuacion}\n`;
    msg += `   📅 ${a.fechaActuacion || "Sin fecha"} — ${doc}\n`;
    if (a.anotacion) msg += `   📝 ${a.anotacion.substring(0, 80)}${a.anotacion.length > 80 ? "..." : ""}\n`;
    msg += "\n";
  }
  msg += `Responda el *número* de la actuación para obtener el documento, o *0* para salir.\n`;
  msg += `_(Solo actuaciones con 📄 tienen documento disponible para descarga)_`;
  return msg;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    // Twilio envía: From=whatsapp:+57..., Body=texto
    const body = req.body;
    if (!body || !body.From || !body.Body) return;
    const telefono = body.From; // ej: "whatsapp:+573001234567"
    const mensaje = (body.Body || "").trim();
    const sesion = sesiones[telefono] || { paso: "inicio" };
    let respuesta = "";

    if (sesion.paso === "inicio") {
      respuesta = "¡Hola! 👋 Soy el asistente de *Sánchez & Cárdenas Consulting*.\n\n¿Desea consultar procesos judiciales activos?\n\nResponda *SÍ* para continuar.";
      sesiones[telefono] = { paso: "esperando_confirmacion" };

    } else if (sesion.paso === "esperando_confirmacion") {
      if (mensaje.toLowerCase().includes("sí") || mensaje.toLowerCase().includes("si")) {
        respuesta = "¿Desea consultar por:\n\n1️⃣ *Nombre o Razón Social*\n2️⃣ *Número de Radicado*\n\nResponda *1* o *2*.";
        sesiones[telefono] = { paso: "esperando_tipo_consulta" };
      } else {
        respuesta = "Entendido. Si necesita consultar en otro momento, escríbame.";
        sesiones[telefono] = { paso: "inicio" };
      }

    } else if (sesion.paso === "esperando_tipo_consulta") {
      if (mensaje === "1") {
        respuesta = "¿El sujeto procesal es:\n\n1️⃣ *Persona Natural*\n2️⃣ *Persona Jurídica*\n\nResponda *1* o *2*.";
        sesiones[telefono] = { paso: "esperando_tipo_persona" };
      } else if (mensaje === "2") {
        respuesta = "Por favor ingrese el *número de radicado* del proceso:";
        sesiones[telefono] = { paso: "esperando_radicado" };
      } else {
        respuesta = "Por favor responda *1* para Nombre o *2* para Radicado.";
      }

    } else if (sesion.paso === "esperando_tipo_persona") {
      if (mensaje === "1") {
        respuesta = "Por favor ingrese el *nombre completo* de la persona natural:";
        sesiones[telefono] = { paso: "esperando_nombre", tipoPersona: "nat" };
      } else if (mensaje === "2") {
        respuesta = "Por favor ingrese la *razón social* de la empresa:";
        sesiones[telefono] = { paso: "esperando_nombre", tipoPersona: "jur" };
      } else {
        respuesta = "Por favor responda *1* para Natural o *2* para Jurídica.";
      }

    } else if (sesion.paso === "esperando_nombre") {
      const tipoPersona = sesion.tipoPersona || "nat";
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorNombre(mensaje, tipoPersona);
      if (!resultado.tieneProcesos || resultado.procesos.length === 0) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = resultado.mensaje || "No se encontraron procesos para ese nombre.";
      } else if (resultado.procesos.length === 1) {
        const proceso = resultado.procesos[0];
        await enviarMensaje(telefono, "⏳ Cargando actuaciones...");
        const actuaciones = await obtenerActuaciones(proceso.idProceso, 10);
        if (!actuaciones || actuaciones.length === 0) {
          sesiones[telefono] = { paso: "inicio" };
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          sesiones[telefono] = { paso: "esperando_seleccion_actuacion", radicado: proceso.llaveProceso, despacho: proceso.despacho, actuaciones };
          respuesta = renderActuaciones(actuaciones, proceso.llaveProceso, proceso.despacho);
        }
      } else {
        const lista = resultado.procesos.slice(0, 8);
        sesiones[telefono] = { paso: "esperando_seleccion_proceso", procesos: lista };
        let msg = `✅ Se encontraron *${resultado.cantidad}* proceso(s).\n\nMostrando los primeros ${lista.length}:\n\n`;
        for (let i = 0; i < lista.length; i++) {
          const p = lista[i];
          msg += `*${i + 1}.* ${p.llaveProceso || "N/A"}\n   Despacho: ${(p.despacho || "N/A").substring(0, 60)}\n   Fecha: ${(p.fechaProceso || "").substring(0, 10) || "N/A"}\n\n`;
        }
        msg += `Responda el *número* del proceso que desea consultar, o *0* para salir.`;
        respuesta = msg;
      }

    } else if (sesion.paso === "esperando_seleccion_proceso") {
      const num = parseInt(mensaje, 10);
      const { procesos } = sesion;
      if (mensaje === "0" || isNaN(num)) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = "Consulta finalizada. Escriba cualquier mensaje para iniciar de nuevo.";
      } else if (num < 1 || num > procesos.length) {
        respuesta = `Por favor responda un número entre 1 y ${procesos.length}, o *0* para salir.`;
      } else {
        const proceso = procesos[num - 1];
        await enviarMensaje(telefono, "⏳ Cargando actuaciones...");
        const actuaciones = await obtenerActuaciones(proceso.idProceso, 10);
        if (!actuaciones || actuaciones.length === 0) {
          sesiones[telefono] = { paso: "inicio" };
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          sesiones[telefono] = { paso: "esperando_seleccion_actuacion", radicado: proceso.llaveProceso, despacho: proceso.despacho, actuaciones };
          respuesta = renderActuaciones(actuaciones, proceso.llaveProceso, proceso.despacho);
        }
      }

    } else if (sesion.paso === "esperando_radicado") {
      const radicado = mensaje.replace(/\s/g, "");
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(radicado);
      if (!resultado.tieneProcesos || resultado.procesos.length === 0) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = resultado.mensaje || "No se encontró el proceso para ese radicado.";
      } else {
        const proceso = resultado.procesos[0];
        const actuaciones = await obtenerActuaciones(proceso.idProceso, 10);
        if (!actuaciones || actuaciones.length === 0) {
          sesiones[telefono] = { paso: "inicio" };
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          sesiones[telefono] = { paso: "esperando_seleccion_actuacion", radicado, despacho: proceso.despacho, actuaciones };
          respuesta = renderActuaciones(actuaciones, radicado, proceso.despacho);
        }
      }

    } else if (sesion.paso === "esperando_seleccion_actuacion") {
      const num = parseInt(mensaje, 10);
      const { radicado, actuaciones } = sesion;
      if (mensaje === "0" || isNaN(num)) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = "Consulta finalizada. Escriba cualquier mensaje para iniciar de nuevo.";
      } else if (num < 1 || num > actuaciones.length) {
        respuesta = `Por favor responda un número entre 1 y ${actuaciones.length}, o *0* para salir.`;
      } else {
        const act = actuaciones[num - 1];
        sesiones[telefono] = { paso: "inicio" };
        let msg = `📄 *${act.actuacion}*\n📅 Fecha: ${act.fechaActuacion || "N/A"}\n`;
        if (act.anotacion) msg += `📝 ${act.anotacion}\n\n`;
        if (tieneMicrositio(act)) {
          const docUrl = micrositioUrl(radicado, act.idRegActuacion);
          sesiones[telefono] = { paso: "esperando_correo_micrositio", act, docUrl, radicado };
          await enviarMensaje(telefono, msg + `⚠️ *Nota:* Solo se pueden recuperar documentos publicados en los *últimos 60 días*.\n\n📧 Por favor ingrese su *correo electrónico* para enviarle el documento adjunto, o *0* para cancelar.`);
          return;
        } else {
          msg += `❌ Esta actuación no tiene documento publicado en el micrositio.`;
        }
        msg += `\n\n📞 Más información: +57 313 829 1633`;
        respuesta = msg;
      }

    } else if (sesion.paso === "esperando_correo_micrositio") {
      if (mensaje === "0") {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = "Cancelado. Escriba cualquier mensaje para iniciar de nuevo.";
      } else {
        const correo = mensaje.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(correo)) {
          respuesta = "Por favor escriba un correo válido (ejemplo: nombre@gmail.com), o *0* para cancelar.";
        } else {
          const { act, docUrl, radicado } = sesion;
          sesiones[telefono] = { paso: "inicio" };
          await enviarMensaje(telefono, `⏳ Obteniendo el documento y enviando a *${correo}*...`);
          try {
            const resultado = await capturarScreenshotMicrositio(radicado, act.idRegActuacion, act.fechaActuacion);
            const base = (radicado || "doc").replace(/\s/g, "_") + "_" + (act.fechaActuacion || "doc");
            const asunto = `Actuación judicial: ${act.actuacion} — ${act.fechaActuacion || ""}`;
            const micrositioLink = `https://publicacionesprocesales.ramajudicial.gov.co/`;
            const cuerpoHtml = `<p><b>Actuación:</b> ${act.actuacion}</p><p><b>Fecha:</b> ${act.fechaActuacion || "N/A"}</p>${act.anotacion ? `<p><b>Anotación:</b> ${act.anotacion}</p>` : ""}<p><b>Radicado:</b> ${radicado}</p>`;
            if (resultado) {
              const filename = `${base}.${resultado.ext}`;
              await enviarPorCorreo(correo, asunto, cuerpoHtml, { filename, buffer: resultado.data });
              await enviarMensaje(telefono, `✅ Documento enviado a *${correo}*\n\n📞 +57 313 829 1633`);
            } else {
              await enviarPorCorreo(correo, asunto, cuerpoHtml + `<p>Consulte el documento en: <a href="${micrositioLink}">${micrositioLink}</a></p>`, null);
              await enviarMensaje(telefono, `✅ Le enviamos el enlace al documento a *${correo}*\n\n📞 +57 313 829 1633`);
            }
          } catch (e) {
            console.error("Error enviando correo:", e.message);
            await enviarMensaje(telefono, `⚠️ No fue posible enviar el correo. Intente de nuevo o contáctenos: +57 313 829 1633`);
          }
          return;
        }
      }

    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Escriba cualquier mensaje para iniciar la consulta.";
    }

    if (respuesta) await enviarMensaje(telefono, respuesta);
  } catch (e) {
    console.error("Error en webhook WhatsApp:", e.message);
  }
});

app.post("/wompi-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-event-checksum"];
    const body = req.body;
    const expected = crypto.createHmac("sha256", WOMPI_EVENTS_SECRET).update(body).digest("hex");
    if (signature !== expected) {
      console.warn("Firma Wompi inválida");
      return res.status(401).json({ error: "Invalid signature" });
    }
    const event = JSON.parse(body.toString());
    res.json({ status: "ok" });
    const txData = event?.data?.transaction;
    if (!txData) return;
    const { reference, status } = txData;
    console.log(`Wompi evento: ref=${reference} status=${status}`);
    if (status !== "APPROVED") return;
    const pending = pendingPayments[reference];
    if (!pending) { console.warn("Pago aprobado sin pendiente:", reference); return; }
    const { telefono, act, radicado, micrositioUrl: docUrl } = pending;
    delete pendingPayments[reference];
    await enviarMensaje(telefono, `✅ *¡Pago confirmado!* Gracias.\n\n⏳ Descargando el documento del micrositio...`);
    let enviado = false;
    if (radicado && act) {
      const resultado = await capturarScreenshotMicrositio(radicado, act.idRegActuacion, act.fechaActuacion);
      if (resultado) {
        const base = (radicado || "doc").replace(/\s/g, "_") + "_" + (act.fechaActuacion || "doc");
        const filename = `${base}.${resultado.ext}`;
        await enviarArchivo(telefono, resultado.data, filename, `📄 ${act.actuacion} — ${act.fechaActuacion || ""}`);
        enviado = true;
      }
    }
    if (!enviado) {
      let msg = `📄 *${act.actuacion}*\n📅 ${act.fechaActuacion || "N/A"}\n\n`;
      msg += `No fue posible descargar el PDF automáticamente.\nConsúltelo en:\n🔗 ${docUrl || "https://publicacionesprocesales.ramajudicial.gov.co/"}\n\nO llámenos:\n📞 +57 313 829 1633`;
      await enviarMensaje(telefono, msg);
    }
  } catch (e) {
    console.error("Error en webhook Wompi:", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// Endpoint para disparar el sync diario (protegido con SYNC_SECRET)
app.post("/run-sync", async (req, res) => {
  const secret = process.env.SYNC_SECRET || "sc-sync-2024";
  const provided = req.headers["x-sync-secret"] || req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: "No autorizado" });
  }
  res.json({ status: "iniciando sync" });
  // Correr en background sin bloquear la respuesta
  try {
    const { execSync } = require("child_process");
    const { exec } = require("child_process");
    exec("node sync-rama-judicial.js", { cwd: __dirname, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) console.error("[run-sync] Error:", err.message);
        if (stdout) console.log("[run-sync] stdout:", stdout.substring(0, 500));
        if (stderr) console.error("[run-sync] stderr:", stderr.substring(0, 300));
        console.log("[run-sync] Finalizado");
      }
    );
  } catch(e) {
    console.error("[run-sync] Error lanzando proceso:", e.message);
  }
});

app.get("/pdf/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, "tmp_pdfs", filename);
  if (fs.existsSync(filepath)) {
    const ext = path.extname(filename).toLowerCase();
    const ct = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".png" ? "image/png"
              : "application/pdf";
    res.setHeader("Content-Type", ct);
    res.sendFile(filepath);
  } else {
    res.status(404).send("Documento no disponible");
  }
});

app.get("/health", (req, res) =>
  res.json({ estado: "OK", servicio: "Sánchez & Cárdenas – Bot Rama Judicial", hora: new Date().toISOString() })
);

// Diagnóstico: prueba completa capturarScreenshotMicrositio con un radicado real
// GET /test-micrositio/11001400302820230068200
app.get("/test-micrositio/:radicado", async (req, res) => {
  const radicado = req.params.radicado;
  const fecha = req.query.fecha || new Date().toISOString().substring(0, 10);
  console.log(`[test-micrositio] radicado=${radicado} fecha=${fecha}`);
  try {
    const resultado = await capturarScreenshotMicrositio(radicado, null, fecha);
    if (resultado) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${radicado}.pdf"`);
      res.send(resultado.data);
    } else {
      // Devolver también la URL de búsqueda útil
      const urlBusqueda = micrositioUrl(radicado, null);
      res.json({ ok: false, mensaje: "No se encontró PDF. Revise logs de Render.", urlBusqueda });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint de diagnóstico: ver qué devuelve el micrositio para un idRegActuacion
app.get("/debug-micrositio/:idReg", async (req, res) => {
  const idReg = req.params.idReg;
  const articleId = req.query.articleId || "2023-00682";
  const PORTLET = "co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq";
  const BASE = "https://publicacionesprocesales.ramajudicial.gov.co";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "es-CO,es;q=0.9",
  };
  try {
    // 1. Página principal lifecycle=0
    const url0 = `${BASE}/web/efectos-procesales-1/-/publicaciones-efectos-procesales?p_p_id=${PORTLET}&p_p_lifecycle=0&_${PORTLET}_articleId=${articleId}&_${PORTLET}_idRegActuacion=${idReg}`;
    const r0 = await axios.get(url0, { timeout: 30000, headers });
    const html = r0.data || "";

    // 2. Buscar links en el HTML
    const links = [];
    const reHref = /href="([^"]+)"/gi;
    let m;
    while ((m = reHref.exec(html)) !== null) {
      if (m[1].includes("document_library") || m[1].includes(".pdf") || m[1].includes("lifecycle=2")) {
        links.push(m[1]);
      }
    }

    // 3. Buscar en scripts
    const scriptUuids = [];
    const reUuid = /['"]([\w-]{36})['"]/g;
    let mu;
    while ((mu = reUuid.exec(html)) !== null) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mu[1])) {
        scriptUuids.push(mu[1]);
      }
    }

    // 4. lifecycle=2 directo con resourceId conocidos
    const lifecycle2Results = {};
    for (const resId of ["descargarDocumento", "getDocumento", "downloadDocument", "serveResource"]) {
      try {
        const url2 = `${BASE}/web/efectos-procesales-1/-/publicaciones-efectos-procesales?p_p_id=${PORTLET}&p_p_lifecycle=2&p_p_resource_id=${resId}&_${PORTLET}_idRegActuacion=${idReg}&_${PORTLET}_articleId=${articleId}`;
        const r2 = await axios.get(url2, { timeout: 10000, headers, maxRedirects: 5 });
        lifecycle2Results[resId] = {
          status: r2.status,
          contentType: r2.headers["content-type"],
          dataLength: (r2.data || "").length || r2.data?.byteLength,
          dataSnippet: typeof r2.data === "string" ? r2.data.substring(0, 200) : "binary"
        };
      } catch(e) {
        lifecycle2Results[resId] = { error: e.message, status: e.response?.status };
      }
    }

    res.json({
      url0,
      status0: r0.status,
      htmlLength: html.length,
      htmlSnippet: html.substring(0, 500),
      linksEncontrados: links,
      uuidsEncontrados: scriptUuids.slice(0, 5),
      lifecycle2Results
    });
  } catch(e) {
    res.status(500).json({ error: e.message, status: e.response?.status });
  }
});

// Diagnóstico Puppeteer: ejecuta el flujo paso a paso y retorna un reporte JSON
// GET /debug-puppeteer/11001400302820230068200
app.get("/debug-puppeteer/:radicado", async (req, res) => {
  const radicado = (req.params.radicado || "").replace(/\s/g, "");
  const reporte = { radicado, pasos: [], error: null };
  let browser2;
  try {
    const puppeteer = require("puppeteer");
    const fs2 = require("fs");
    const { execSync } = require("child_process");
    const cacheDir2 = process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer";
    let foundExec2 = null;
    try { const ep = puppeteer.executablePath(); if (ep && fs2.existsSync(ep)) foundExec2 = ep; } catch(_) {}
    if (!foundExec2) {
      try {
        const hits = execSync(`find ${cacheDir2} -name "chrome" -type f 2>/dev/null | head -3`, { encoding: "utf8" }).trim();
        reporte.chromeFind = hits || "nada";
        const lines = hits.split("\n").filter(Boolean);
        for (const line of lines) { try { execSync(`test -x "${line}"`); foundExec2 = line; break; } catch(_) {} }
      } catch(e) { reporte.chromeFindError = e.message; }
    }
    if (!foundExec2) {
      try {
        reporte.instalandoChrome = true;
        execSync(`npx puppeteer browsers install chrome`, { encoding: "utf8", stdio: "pipe", env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir2 } });
        try { const ep = puppeteer.executablePath(); if (ep && fs2.existsSync(ep)) foundExec2 = ep; } catch(_) {}
      } catch(e) { reporte.chromeInstallError = e.message; }
    }
    reporte.executablePath = foundExec2 || "default";
    reporte.cacheDir = cacheDir2;

    browser2 = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
      executablePath: foundExec2 || undefined,
    });
    const pg = await browser2.newPage();
    await pg.setViewport({ width: 1280, height: 900 });
    await pg.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // PASO 1: Navegar
    reporte.pasos.push({ paso: "navegar", inicio: Date.now() });
    await pg.goto("https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales/inicio", {
      waitUntil: "domcontentloaded", timeout: 90000
    });
    reporte.pasos[reporte.pasos.length-1].fin = Date.now();
    reporte.pasos[reporte.pasos.length-1].url = pg.url();

    // PASO 2: Esperar selects
    let optCount = -1;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      optCount = await pg.evaluate(() => { const s = document.getElementById('departamento') || document.querySelector('select'); return s ? s.options.length : -1; });
      if (optCount > 1) break;
    }
    // Listar todos los selects con sus IDs y opciones
    const selectsInfo = await pg.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map(s => ({
        id: s.id, name: s.name, optCount: s.options.length,
        primerasOpts: Array.from(s.options).slice(0, 4).map(o => ({ val: o.value.trim(), txt: o.text.trim() }))
      }));
    });
    reporte.pasos.push({ paso: "selects_info", selectsInfo, departamentoOpts: optCount });

    // PASO 3: Intentar seleccionar departamento y ver qué pasa
    const r = radicado;
    const idDepto = r.substring(0, 2);
    const idMuni  = r.substring(0, 5);   // "11001" — el select usa dep+mun (5 dígitos)
    const idEnt   = r.substring(5, 7);
    const idEsp   = r.substring(7, 9);
    const idNum   = r.substring(9, 12);
    const idDesp  = idDepto + r.substring(2,5) + idEnt + idEsp + idNum; // "110014003028"
    reporte.filtros = { idDepto, idMuni, idEnt, idEsp, idNum, idDesp };

    const probarSelect = async (selectId, value) => {
      await new Promise(r => setTimeout(r, 1500));
      return pg.evaluate((selId, val) => {
        const sel = document.getElementById(selId);
        if (!sel) return { ok: false, msg: `no existe #${selId}` };
        const opts = Array.from(sel.options).map(o => o.value.trim());
        const encontrado = opts.find(v => v === val || v === " " + val);
        if (!encontrado) return { ok: false, msg: `"${val}" no en #${selId}`, optsDisponibles: opts.slice(0, 8) };
        if (typeof jQuery !== 'undefined') {
          jQuery('#' + selId).val(encontrado).trigger('change');
          return { ok: true, msg: `jQuery ok #${selId}="${encontrado}"` };
        }
        sel.value = encontrado;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, msg: `native ok #${selId}="${encontrado}"` };
      }, selectId, value);
    };

    reporte.pasos.push({ paso: "select_departamento", resultado: await probarSelect('departamento', idDepto) });
    await new Promise(r => setTimeout(r, 3000));
    reporte.pasos.push({ paso: "select_municipio", resultado: await probarSelect('municipio', idMuni) });
    await new Promise(r => setTimeout(r, 3000));
    reporte.pasos.push({ paso: "select_entidad", resultado: await probarSelect('entidad', idEnt) });
    await new Promise(r => setTimeout(r, 3000));
    reporte.pasos.push({ paso: "select_especialidad", resultado: await probarSelect('especialidad', idEsp) });
    await new Promise(r => setTimeout(r, 3000));
    reporte.pasos.push({ paso: "select_despacho", resultado: await probarSelect('despacho', idDesp) });
    await new Promise(r => setTimeout(r, 2000));

    // PASO 4: Buscar el botón BUSCAR
    const btnInfo = await pg.evaluate(() => {
      const btn = document.getElementById('buscar') || document.querySelector('button[type="submit"], input[type="submit"]');
      return btn ? { id: btn.id, type: btn.type, text: btn.textContent?.trim(), tagName: btn.tagName } : null;
    });
    reporte.pasos.push({ paso: "boton_buscar", btnInfo });

    if (btnInfo) {
      await pg.evaluate(() => {
        const btn = document.getElementById('buscar') || document.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 15000));
      const htmlRes = await pg.evaluate(() => document.body.innerHTML);
      const articleIds = [];
      const re = /articleId[=\s:"']+(\d{6,12})/gi;
      let m;
      while ((m = re.exec(htmlRes)) !== null) if (!articleIds.includes(m[1])) articleIds.push(m[1]);
      reporte.pasos.push({
        paso: "resultados",
        articleIds,
        htmlSnippet: htmlRes.substring(0, 1000),
        textoVisible: (await pg.evaluate(() => document.body.innerText)).substring(0, 500)
      });
    }

    await browser2.close();
    res.json(reporte);
  } catch(e) {
    if (browser2) try { await browser2.close(); } catch(_) {}
    reporte.error = e.message;
    res.status(500).json(reporte);
  }
});

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

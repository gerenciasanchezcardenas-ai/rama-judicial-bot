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
  // Solo hay documento publicado en el micrositio cuando es "Fijacion estado"
  return tip.includes("fijacion estado") || tip.includes("fijación estado");
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
// usando HTTP puro (axios) — sin Puppeteer ni Chrome.
// Flujo: POST búsqueda → extraer articleId del radicado → GET detalle → extraer uuid → descargar PDF
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

  try {
    const r = (radicado || "").replace(/\s/g, "");
    if (r.length < 20) { console.error("[micrositio] radicado inválido:", radicado); return null; }

    // Extraer componentes del radicado (23 dígitos)
    // 11  001  40  03  028  2023  00068  200
    // dep mun  ent esp  num  año  consec inst
    const idDepto       = r.substring(0, 2);          // "11"
    const idMuni        = r.substring(0, 5);          // "11001"
    const idEntidad     = r.substring(5, 7);          // "40"
    const idEspecialidad = r.substring(7, 9);         // "03"
    const idDespacho    = r.substring(0, 12);         // "110014003028"

    // Fechas: rango ±7 días alrededor de la fecha de la actuación
    const fechaStr = fechaActuacion ? fechaActuacion.substring(0, 10) : new Date().toISOString().substring(0, 10);
    const fInicio = new Date(fechaStr); fInicio.setDate(fInicio.getDate() - 7);
    const fFin    = new Date(fechaStr); fFin.setDate(fFin.getDate() + 7);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    console.log(`[micrositio] radicado=${r} despacho=${idDespacho} fecha=${fechaStr} rango=${fmt(fInicio)}→${fmt(fFin)}`);

    // ── PASO 1: GET sesión para obtener cookies ──
    const homeResp = await axios.get(`${BASE}/web/publicaciones-procesales/inicio`, {
      headers: HEADERS, timeout: 25000, maxRedirects: 5, validateStatus: () => true,
    });
    const cookieStr = (homeResp.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
    console.log(`[micrositio] cookies: ${cookieStr.substring(0, 80)}`);

    // ── PASO 2: GET búsqueda con los filtros correctos (URL confirmada por Network capture) ──
    // action=busqueda con idDepto, idMuni, idEntidad, idEspecialidad, idDespacho, fechaInicio, fechaFin
    const params = new URLSearchParams({
      "p_p_id": PORTLET,
      "p_p_lifecycle": "0",
      "p_p_state": "normal",
      "p_p_mode": "view",
      [`${P}_action`]: "busqueda",
      [`${P}_fechaInicio`]: fmt(fInicio),
      [`${P}_fechaFin`]: fmt(fFin),
      [`${P}_idDepto`]: idDepto,
      [`${P}_idMuni`]: idMuni,
      [`${P}_idEntidad`]: idEntidad,
      [`${P}_idEspecialidad`]: idEspecialidad,
      [`${P}_idDespacho`]: idDespacho,
      [`${P}_verTotales`]: "false",
    });

    const busqUrl = `${BASE}/web/publicaciones-procesales/inicio?${params.toString()}`;
    console.log(`[micrositio] GET búsqueda: ${busqUrl.substring(0, 200)}`);

    const busqResp = await axios.get(busqUrl, {
      headers: { ...HEADERS, "Cookie": cookieStr, "Referer": `${BASE}/web/publicaciones-procesales/inicio` },
      timeout: 30000, maxRedirects: 5, validateStatus: () => true,
    });
    const htmlBusq = busqResp.data || "";
    console.log(`[micrositio] búsqueda status=${busqResp.status} bytes=${htmlBusq.length}`);

    // ── PASO 3: en los resultados, buscar el link del estado que corresponde al radicado ──
    // El HTML tiene cards de publicaciones con links "VER DETALLE" que contienen articleId
    // También puede tener el número de radicado visible en el texto
    // Extraer todos los articleId presentes
    const reArt = /articleId[=\s:"']+(\d{6,12})/gi;
    let ma;
    const articleIds = [];
    while ((ma = reArt.exec(htmlBusq)) !== null) {
      if (!articleIds.includes(ma[1])) articleIds.push(ma[1]);
    }
    console.log(`[micrositio] articleIds encontrados: ${articleIds.join(", ") || "ninguno"}`);

    if (articleIds.length === 0) {
      // Si no hay resultados directos, buscar la categoría "Notificaciones por Estados" y filtrar
      // El portal muestra categorías — si hay Fijaciones o Notificaciones por Estados, buscar dentro
      const tieneResultados = htmlBusq.includes("articleId") || htmlBusq.includes("VER DETALLE") || htmlBusq.includes("ver-detalle");
      console.log(`[micrositio] tieneResultados=${tieneResultados}. HTML[0-600]: ${htmlBusq.substring(0, 600)}`);
      return null;
    }

    // Buscar el articleId que corresponde al radicado correcto
    // El radicado tiene partes identificadoras: año (pos 12-15) y consecutivo (pos 16-20)
    const anioRad   = r.substring(12, 16); // e.g. "2023"
    const consecRad = r.substring(16, 21); // e.g. "00068"
    // También intentar con el radicado completo sin espacios
    const buscarEn = [r, anioRad + consecRad, consecRad, anioRad];

    let articleId = null;
    // Primer intento: buscar por contexto cercano al articleId
    for (const aid of articleIds) {
      const idx = htmlBusq.indexOf(`articleId=${aid}`);
      if (idx > -1) {
        const contexto = htmlBusq.substring(Math.max(0, idx - 500), idx + 500);
        for (const token of buscarEn) {
          if (token && contexto.includes(token)) {
            articleId = aid;
            console.log(`[micrositio] articleId=${aid} coincide por token="${token}"`);
            break;
          }
        }
        if (articleId) break;
      }
    }

    // Segundo intento: buscar en todo el HTML cuál bloque contiene el radicado
    if (!articleId) {
      for (const token of buscarEn) {
        if (!token) continue;
        const idxToken = htmlBusq.indexOf(token);
        if (idxToken > -1) {
          // Buscar el articleId más cercano a este token
          const ventana = htmlBusq.substring(Math.max(0, idxToken - 1000), idxToken + 1000);
          const mLocal = /articleId[=\s:"']+(\d{6,12})/i.exec(ventana);
          if (mLocal) {
            articleId = mLocal[1];
            console.log(`[micrositio] articleId=${articleId} encontrado cerca de token="${token}"`);
            break;
          }
        }
      }
    }

    // ── PASO 4: recorrer cada articleId buscando el que contiene el radicado en su detalle ──
    // El HTML de búsqueda NO incluye el radicado — hay que entrar al detalle de cada uno
    const tokensRad = [r, anioRad + consecRad, consecRad];
    let htmlDetalle = "";
    articleId = null;

    for (const aid of articleIds) {
      const dUrl = `${BASE}/web/publicaciones-procesales/inicio?p_p_id=${PORTLET}&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&${P}_jspPage=%2FMETA-INF%2Fresources%2Fdetail.jsp&${P}_articleId=${aid}`;
      console.log(`[micrositio] GET detalle articleId=${aid}`);
      const dResp = await axios.get(dUrl, {
        headers: { ...HEADERS, "Cookie": cookieStr, "Referer": busqUrl },
        timeout: 25000, maxRedirects: 5, validateStatus: () => true,
      });
      const htmlD = dResp.data || "";
      console.log(`[micrositio] detalle ${aid} status=${dResp.status} bytes=${htmlD.length}`);

      // Verificar si este detalle contiene el radicado
      const coincide = tokensRad.some(t => t && htmlD.includes(t));
      if (coincide) {
        articleId = aid;
        htmlDetalle = htmlD;
        console.log(`[micrositio] articleId=${aid} COINCIDE con radicado`);
        break;
      } else {
        console.log(`[micrositio] articleId=${aid} no coincide, siguiente...`);
      }
    }

    if (!articleId) {
      console.log(`[micrositio] Ningún articleId coincidió con el radicado. Tokens buscados: ${tokensRad.join(", ")}`);
      return null;
    }

    // ── PASO 5: extraer uuid del PDF ──
    let uuid = null, groupId = GROUP_ID;
    const uuidPatterns = [
      /uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&groupId=(\d+)/i,
      /get_file\?uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /uuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    ];
    for (const pat of uuidPatterns) {
      const mu = pat.exec(htmlDetalle);
      if (mu) { uuid = mu[1]; if (mu[2]) groupId = mu[2]; break; }
    }

    if (!uuid) {
      console.log(`[micrositio] uuid no encontrado. Detalle[0-600]: ${htmlDetalle.substring(0, 600)}`);
      return null;
    }

    const pdfUrl = `${BASE}/c/document_library/get_file?uuid=${uuid}&groupId=${groupId}`;
    console.log(`[micrositio] PDF URL: ${pdfUrl}`);

    // ── PASO 6: descargar PDF ──
    const pdfResp = await axios.get(pdfUrl, {
      headers: { ...HEADERS, "Cookie": cookieStr },
      responseType: "arraybuffer", timeout: 40000, validateStatus: () => true,
    });

    if (pdfResp.status !== 200) {
      console.log(`[micrositio] descarga PDF status=${pdfResp.status}`);
      return null;
    }

    const pdfBuffer = Buffer.from(pdfResp.data);
    console.log(`[micrositio] PDF OK bytes=${pdfBuffer.length}`);

    if (pdfBuffer.length < 500) {
      console.log(`[micrositio] respuesta muy pequeña: ${pdfBuffer.toString("utf8", 0, 200)}`);
      return null;
    }

    return { tipo: "pdf", data: pdfBuffer, ext: "pdf" };

  } catch (e) {
    console.error(`[micrositio] Error general:`, e.message, e.response?.status);
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
          await enviarMensaje(telefono, msg + `📧 Por favor ingrese su *correo electrónico* para enviarle el documento, o *0* para cancelar.`);
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

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

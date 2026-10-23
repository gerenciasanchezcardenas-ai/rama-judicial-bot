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
  const ann = (act.anotacion || "").toLowerCase();
  const tip = (act.actuacion || "").toLowerCase();
  return (
    ann.includes("publicado") || ann.includes("micrositio") || ann.includes("ramajudicial.gov.co") ||
    tip.includes("auto") || tip.includes("sentencia") || tip.includes("providencia") ||
    tip.includes("fallo") || tip.includes("resolucion") ||
    (act.idRegActuacion && ann.length > 20)
  );
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
  // Devuelve la URL raíz del micrositio para usar en emails como referencia
  return `https://publicacionesprocesales.ramajudicial.gov.co/`;
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

// Navega el micrositio aplicando los filtros via Select2/jQuery y descarga
// el documento de la actuación con el idRegActuacion dado.
// Retorna { tipo, data, ext } o null si falla.
async function capturarScreenshotMicrositio(radicado, idRegActuacion, fechaActuacion) {
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

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // 1. Navegar al micrositio
    console.log("Navegando al micrositio raíz...");
    await page.goto("https://publicacionesprocesales.ramajudicial.gov.co/", {
      waitUntil: "networkidle2", timeout: 60000
    });
    await page.waitForTimeout(3000);

    // 2. Seleccionar Despacho via jQuery/Select2
    // Los selects son nativos pero Select2 los envuelve; jQuery está disponible en la página
    // El select #despacho ya tiene las 5000+ opciones precargadas (no es lazy)
    console.log("Seleccionando Despacho:", despachoCod);
    const despachoOk = await page.evaluate((cod) => {
      const sel = document.getElementById('despacho');
      if (!sel) return 'no select#despacho';
      // Buscar el option (puede tener espacio inicial en el value)
      const opt = Array.from(sel.options).find(o => o.value.trim() === cod);
      if (!opt) return 'option no encontrado para: ' + cod;
      // Seleccionar via jQuery para que Select2 lo reconozca
      if (typeof jQuery !== 'undefined') {
        jQuery('#despacho').val(opt.value).trigger('change');
        return 'ok-jquery:' + opt.value;
      } else {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok-native:' + opt.value;
      }
    }, despachoCod);
    console.log("Despacho resultado:", despachoOk);
    await page.waitForTimeout(1500);

    // 3. Ajustar fechas (formato YYYY-MM-DD para input[type="date"])
    if (fechaActuacion) {
      try {
        const fActuacion = new Date(fechaActuacion);
        const fInicio = new Date(fActuacion);
        fInicio.setMonth(fInicio.getMonth() - 3);
        const fFin = new Date(fActuacion);
        fFin.setMonth(fFin.getMonth() + 1);
        const fmt = d => d.toISOString().substring(0, 10); // YYYY-MM-DD
        await page.evaluate((fi, ff) => {
          // Los IDs son largos con el portletId
          const inputs = document.querySelectorAll('input[type="date"]');
          if (inputs[0]) { inputs[0].value = fi; inputs[0].dispatchEvent(new Event('change', { bubbles: true })); }
          if (inputs[1]) { inputs[1].value = ff; inputs[1].dispatchEvent(new Event('change', { bubbles: true })); }
        }, fmt(fInicio), fmt(fFin));
        console.log("Fechas:", fmt(fInicio), "->", fmt(fFin));
      } catch(dateErr) { console.warn("Error ajustando fechas:", dateErr.message); }
    }

    // 4. Clic en BUSCAR (el botón tiene id="buscar")
    console.log("Haciendo clic en BUSCAR...");
    await page.evaluate(() => {
      const btn = document.getElementById('buscar');
      if (btn) btn.click();
    });
    // Esperar que carguen los resultados
    await page.waitForTimeout(6000);

    // 5. Buscar el documento con idRegActuacion en los resultados
    console.log("Buscando documento con idRegActuacion:", idRegActuacion);
    let pdfUrl = null;

    // Buscar link que contenga el idRegActuacion en href o en texto cercano
    pdfUrl = await page.evaluate((idReg, consec, year) => {
      const idStr = String(idReg);
      const textoRef = `${year}-${consec}`;

      // 1) Link directo con idRegActuacion
      let link = Array.from(document.querySelectorAll('a[href]'))
        .find(a => a.href.includes(idStr));
      if (link) return link.href;

      // 2) Buscar por texto AAAA-NNNNN en tarjetas/filas y tomar el primer link
      const allEls = Array.from(document.querySelectorAll('td, .card-body, .item, li, div'));
      for (const el of allEls) {
        if (el.children.length === 0 && el.textContent.includes(textoRef)) {
          const row = el.closest('tr, .card, .publicacion, article, li');
          if (row) {
            const a = row.querySelector('a[href]');
            if (a) return a.href;
          }
        }
      }

      // 3) Cualquier link PDF o de documento en la página de resultados
      const pdfLink = Array.from(document.querySelectorAll('a[href]'))
        .find(a => /\.(pdf|PDF)/.test(a.href) || /document|archivo|descargar|ver/i.test(a.textContent));
      if (pdfLink) return pdfLink.href;

      return null;
    }, String(idRegActuacion), consec, year);

    if (pdfUrl) {
      console.log("URL documento encontrada:", pdfUrl);
      // Descargar con las cookies de sesión
      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const pdfRes = await axios.get(pdfUrl, {
        responseType: "arraybuffer",
        timeout: 60000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Cookie": cookieStr,
          "Accept": "application/pdf,*/*",
          "Referer": "https://publicacionesprocesales.ramajudicial.gov.co/"
        }
      });
      await browser.close();
      const contentType = pdfRes.headers["content-type"] || "";
      const ext = contentType.includes("pdf") ? "pdf" : "bin";
      return { tipo: "pdf", data: Buffer.from(pdfRes.data), ext };
    }

    // Si no se encontró link, tomar screenshot de los resultados
    console.log("No se encontró link PDF, tomando screenshot de resultados...");
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

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

async function enviarDocumento(telefono, pdfBuffer, filename, caption) {
  try {
    // Guardar PDF temporalmente y servirlo como URL pública
    const tmpDir = path.join(__dirname, "tmp_pdfs");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, filename);
    fs.writeFileSync(tmpFile, pdfBuffer);
    const pdfUrl = `https://rama-judicial-bot.onrender.com/pdf/${encodeURIComponent(filename)}`;
    // Enviar como media via Twilio
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const from = TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? TWILIO_WHATSAPP_NUMBER : `whatsapp:${TWILIO_WHATSAPP_NUMBER}`;
    const to = telefono.startsWith("whatsapp:") ? telefono : `whatsapp:${telefono}`;
    await axios.post(url,
      new URLSearchParams({ From: from, To: to, Body: caption || filename, MediaUrl: pdfUrl }).toString(),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );
    // Limpiar archivo después de 5 minutos
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch(e) {} }, 5 * 60 * 1000);
  } catch (e) {
    console.error("Error enviando documento:", e.response?.data || e.message);
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

function micrositioUrl(radicado, idRegActuacion) {
  const r = (radicado || "").replace(/\s/g, "");
  if (r.length >= 21) {
    const year = r.substring(12, 16);
    const num = r.substring(16, 21);
    const articleId = `${year}-${num}`;
    const portletId = "co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq";
    return `https://publicacionesprocesales.ramajudicial.gov.co/web/efectos-procesales-1/-/publicaciones-efectos-procesales?p_p_id=${portletId}&p_p_lifecycle=0&_${portletId}_articleId=${articleId}&_${portletId}_idRegActuacion=${idRegActuacion}`;
  }
  return null;
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

async function descargarPdfMicrositio(url) {
  const BASE_MICROSITIO = "https://publicacionesprocesales.ramajudicial.gov.co";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
    "Referer": BASE_MICROSITIO + "/"
  };
  try {
    console.log("Descargando página micrositio:", url);
    const pageRes = await axios.get(url, { timeout: 30000, headers });
    const html = pageRes.data || "";
    console.log("HTML micrositio length:", html.length, "status:", pageRes.status);

    // Extraer la URL del PDF probando varios patrones
    let pdfUrl = null;

    // Patrón 1: document_library/get_file con uuid
    const m1 = html.match(/["']((?:https?:\/\/[^"']*)?\/c\/document_library\/get_file[^"']*uuid=[^"']+)["']/i);
    if (m1) pdfUrl = m1[1];

    // Patrón 2: href con .pdf
    if (!pdfUrl) {
      const m2 = html.match(/href=["']([^"']*\.pdf[^"']*)["']/i);
      if (m2) pdfUrl = m2[1];
    }

    // Patrón 3: src o data-url con document_library
    if (!pdfUrl) {
      const m3 = html.match(/["']((?:https?:\/\/[^"']*)?\/c\/document_library\/[^"']+)["']/i);
      if (m3) pdfUrl = m3[1];
    }

    // Patrón 4: buscar en JS embebido (variables con uuid o fileUrl)
    if (!pdfUrl) {
      const m4 = html.match(/uuid['":\s]+['"]([0-9a-f-]{36})['"]/i);
      if (m4) {
        const uuid = m4[1];
        // groupId predeterminado del micrositio
        pdfUrl = `${BASE_MICROSITIO}/c/document_library/get_file?uuid=${uuid}&groupId=6098902`;
      }
    }

    if (pdfUrl) {
      if (pdfUrl.startsWith("/")) pdfUrl = BASE_MICROSITIO + pdfUrl;
      console.log("PDF URL encontrada:", pdfUrl);
      const pdfRes = await axios.get(pdfUrl, {
        responseType: "arraybuffer",
        timeout: 45000,
        headers: { ...headers, "Accept": "application/pdf,*/*" }
      });
      const ct = pdfRes.headers["content-type"] || "";
      if (ct.includes("pdf") || ct.includes("octet-stream") || pdfUrl.includes("get_file") || pdfUrl.includes(".pdf")) {
        console.log("PDF descargado, bytes:", pdfRes.data.byteLength);
        return Buffer.from(pdfRes.data);
      }
      console.log("Respuesta no es PDF, content-type:", ct);
    } else {
      console.log("No se encontró URL PDF en el HTML. Primeros 500 chars:", html.substring(0, 500));
    }
    return null;
  } catch (e) {
    console.error("Error descargando PDF micrositio:", e.response?.status, e.message);
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
          await enviarMensaje(telefono, msg + `⏳ Descargando documento del micrositio...`);
          const pdf = await descargarPdfMicrositio(docUrl);
          if (pdf) {
            const filename = `${(radicado || "doc").replace(/\s/g, "_")}_${act.fechaActuacion || "doc"}.pdf`;
            await enviarDocumento(telefono, pdf, filename, `📄 ${act.actuacion} — ${act.fechaActuacion || ""}`);
          } else {
            await enviarMensaje(telefono, `✅ Documento disponible en el micrositio:\n🔗 ${docUrl || "https://publicacionesprocesales.ramajudicial.gov.co/"}\n\n📞 +57 313 829 1633`);
          }
          return;
        } else {
          msg += `❌ Esta actuación no tiene documento publicado en el micrositio.`;
        }
        msg += `\n\n📞 Más información: +57 313 829 1633`;
        respuesta = msg;
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
    if (docUrl) {
      const pdf = await descargarPdfMicrositio(docUrl);
      if (pdf) {
        const filename = `${(radicado || "doc").replace(/\s/g, "_")}_${act.fechaActuacion || "doc"}.pdf`;
        await enviarDocumento(telefono, pdf, filename, `📄 ${act.actuacion} — ${act.fechaActuacion || ""}`);
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
    res.setHeader("Content-Type", "application/pdf");
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

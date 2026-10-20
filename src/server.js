// ============================================================
// PERFIL JURÍDICO Y PATRIMONIAL — Sánchez & Cárdenas Consulting S.A.S.
// Bot de WhatsApp (Twilio) + pagos Wompi + reporte PDF.
// Fuentes automáticas: Rama Judicial y SECOP II. Supernotariado: consulta de la firma.
// ============================================================
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const twilio = require("twilio");

const db = require("./db");
const rama = require("./rama");
const secop = require("./secop");
const wompi = require("./wompi");
const { generarPDF } = require("./reporte");

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://rama-judicial-bot.onrender.com").replace(/\/$/, "");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const VALOR_CENTAVOS = Number(process.env.PRECIO_CENTAVOS || 5000000); // $50.000 COP
const HORAS_SNR = Number(process.env.HORAS_ENTREGA_SNR || 12);
const POLITICA_URL = process.env.POLITICA_DATOS_URL || "";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const tw = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// ── Utilidades ───────────────────────────────────────────────
const normal = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const fmtCOP = (centavos) => "$" + Math.round(centavos / 100).toLocaleString("es-CO");
const fmtFechaHora = (iso) =>
  new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });

async function enviar(telefono, texto, mediaUrl) {
  if (!tw) return console.log("[sin Twilio] →", telefono, texto, mediaUrl || "");
  try {
    const msg = { from: TWILIO_WHATSAPP_NUMBER, to: "whatsapp:+" + telefono, body: texto };
    if (mediaUrl) msg.mediaUrl = [mediaUrl];
    await tw.messages.create(msg);
  } catch (e) {
    console.error("Error enviando WhatsApp:", e.message);
    throw e;
  }
}

// Aviso por correo a la firma cuando entra un pago (opcional: requiere RESEND_API_KEY).
async function avisarFirma(sol) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FIRMA) return;
  try {
    await axios.post("https://api.resend.com/emails", {
      from: process.env.EMAIL_REMITENTE || "Perfil Jurídico <onboarding@resend.dev>",
      to: [process.env.EMAIL_FIRMA],
      subject: `Supernotariado pendiente · ${sol.nombre} · vence ${fmtFechaHora(sol.snr_vence_at)}`,
      html: `<p>Entró un pago del Perfil Jurídico y Patrimonial. Falta la consulta en la Supernotariado.</p>
        <p><b>Persona consultada:</b> ${sol.nombre}<br><b>Documento:</b> ${sol.tipo_documento} ${sol.documento}<br>
        <b>Referencia:</b> ${sol.referencia}<br><b>Entregar a más tardar:</b> ${fmtFechaHora(sol.snr_vence_at)}</p>`,
    }, { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 15000 });
  } catch (e) {
    console.error("Error avisando a la firma:", e.message);
  }
}

// ── Textos del recorrido ─────────────────────────────────────
const TXT = {
  bienvenida:
    "Hola. Le habla el asistente de *Sánchez & Cárdenas Consulting*.\n\n" +
    "Con el *Perfil Jurídico y Patrimonial* usted conoce, a partir del nombre y el documento de una persona o empresa:\n\n" +
    "⚖️ Los procesos judiciales en los que figura (Rama Judicial).\n" +
    "🏛️ Sus contratos con entidades públicas y los saldos que el Estado le debe (SECOP II).\n" +
    "🏠 Los inmuebles registrados a su nombre (Supernotariado).\n\n" +
    `Valor: *${fmtCOP(VALOR_CENTAVOS)}*. Antes de pagar recibe un resultado preliminar gratuito.\n\n` +
    "Para continuar, confirme que usará la información con un fin legítimo, como evaluar un negocio, una deuda o un proceso" +
    (POLITICA_URL ? `, y que acepta nuestra política de tratamiento de datos: ${POLITICA_URL}` : "") +
    ".\n\nResponda *ACEPTO* para continuar.",
  tipoPersona: "¿A quién desea consultar?\n\n*1.* Una persona natural\n*2.* Una empresa (persona jurídica)\n\nResponda 1 o 2.",
  nombreNat: "Escriba el *nombre completo* de la persona, con nombres y apellidos, tal como aparece en su cédula.",
  nombreJur: "Escriba la *razón social completa* de la empresa. Ejemplo: COMERCIALIZADORA ANDINA S.A.S.",
  docNat: "Ahora escriba el *número de cédula*, sin puntos ni espacios.\n\nSi es cédula de extranjería, escriba CE antes del número. Ejemplo: CE 123456",
  docJur: "Ahora escriba el *NIT* de la empresa, sin puntos y sin dígito de verificación.",
  consultando: "Estamos consultando la Rama Judicial y el SECOP. Puede tardar hasta un minuto.",
  sigueConsultando: "Seguimos consultando, un momento por favor.",
  menu: "Listo, empezamos de nuevo.",
};

// ── Consulta preliminar y creación de la solicitud ───────────
async function ejecutarConsulta(telefono, datos) {
  await db.guardarSesion(telefono, "consultando", datos);
  await enviar(telefono, TXT.consultando);

  const [resRama, resSecop] = await Promise.all([
    rama.consultarPorNombre(datos.nombre, datos.tipoPersona),
    secop.consultarContratos(datos.documento),
  ]);

  if (resRama.demasiados) {
    await db.guardarSesion(telefono, "esperando_nombre", datos);
    return enviar(telefono,
      "La Rama Judicial encontró más de mil coincidencias para ese nombre y no entrega el listado. " +
      "Escríbalo completo, con los dos apellidos (o la razón social exacta), para afinar la búsqueda.");
  }

  const referencia = "PJP-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
  const sol = await db.crearSolicitud({
    referencia,
    token_reporte: crypto.randomBytes(24).toString("hex"),
    telefono,
    tipo_persona: datos.tipoPersona,
    nombre: datos.nombre,
    tipo_documento: datos.tipoDocumento,
    documento: datos.documento,
    acepto_terminos_at: datos.aceptoAt,
    resultado_rama: resRama,
    resultado_secop: resSecop,
    valor_centavos: VALOR_CENTAVOS,
  });

  const r = rama.resumenRama(resRama.procesos);
  const s = secop.resumenSecop(resSecop.contratos);
  const enlace = wompi.enlacePago(referencia, VALOR_CENTAVOS);

  let lineaRama = resRama.ok
    ? `⚖️ Procesos judiciales: *${resRama.total}*` + (r.total ? ` (${r.recientes} con actuaciones en el último año)` : "")
    : "⚖️ Procesos judiciales: la Rama Judicial no respondió; el informe los incluirá.";
  let lineaSecop = resSecop.ok
    ? `🏛️ Contratos con entidades públicas: *${s.total}*` + (s.pendiente > 0 ? " (con saldos pendientes de pago)" : "")
    : "🏛️ Contratos públicos: el SECOP no respondió; el informe los incluirá.";

  await db.guardarSesion(telefono, "esperando_pago", { referencia });
  return enviar(telefono,
    `*Resultado preliminar para ${sol.nombre.toUpperCase()}*\n\n${lineaRama}\n${lineaSecop}\n` +
    `🏠 Bienes inmuebles: se consultan después del pago y se entregan dentro de ${HORAS_SNR} horas.\n\n` +
    "El informe completo en PDF trae radicados, despachos, partes, última actuación, contratos, valores, " +
    "cuentas donde recibe pagos y observaciones para el cobro.\n\n" +
    `💳 Valor: *${fmtCOP(VALOR_CENTAVOS)}*. Pague aquí:\n${enlace}\n\n` +
    "Si no desea continuar, escriba *MENÚ*.");
}

// ── Entrega después del pago (idempotente) ───────────────────
async function procesarPago(referencia, transaccionId) {
  const vence = new Date(Date.now() + HORAS_SNR * 3600 * 1000).toISOString();
  const sol = await db.actualizarSolicitud(referencia,
    { estado: "pagado", pagado_at: new Date().toISOString(), wompi_transaccion: transaccionId || null, snr_vence_at: vence },
    "pendiente_pago");
  if (!sol) return; // ya procesado o inexistente

  await enviar(sol.telefono, "✅ Pago confirmado. Estamos preparando su informe; tarda alrededor de un minuto.").catch(() => {});

  // Detalle de la última actuación de los procesos más recientes
  if (sol.resultado_rama && sol.resultado_rama.procesos && sol.resultado_rama.procesos.length) {
    await rama.completarActuaciones(sol.resultado_rama.procesos);
    await db.actualizarSolicitud(referencia, { resultado_rama: sol.resultado_rama });
  }

  try {
    await enviar(sol.telefono,
      `📄 Este es su *Perfil Jurídico y Patrimonial* de ${sol.nombre.toUpperCase()}.\n\n` +
      `La consulta de inmuebles en la Supernotariado está en curso. Recibirá el complemento a más tardar el *${fmtFechaHora(vence)}*\n\n` +
      `Referencia: ${referencia}`,
      `${BASE_URL}/reporte/${sol.token_reporte}.pdf`);
    await db.actualizarSolicitud(referencia, { estado: "reporte_enviado", reporte_enviado_at: new Date().toISOString() });
  } catch (e) {
    await enviar(sol.telefono,
      `Su pago quedó registrado, pero no pudimos adjuntar el PDF. Descárguelo aquí: ${BASE_URL}/reporte/${sol.token_reporte}.pdf`).catch(() => {});
  }
  await avisarFirma({ ...sol, snr_vence_at: vence });
  await db.guardarSesion(sol.telefono, "inicio", {});
}

// ── Conversación ─────────────────────────────────────────────
async function atender(telefono, mensaje) {
  const m = normal(mensaje);
  const sesion = await db.leerSesion(telefono);
  const datos = sesion.datos || {};

  if (m.startsWith("join")) {
    await db.guardarSesion(telefono, "esperando_aceptacion", {});
    return enviar(telefono, TXT.bienvenida);
  }
  if (["menu", "nueva", "reiniciar", "inicio"].includes(m)) {
    await db.guardarSesion(telefono, "esperando_aceptacion", {});
    return enviar(telefono, TXT.menu + "\n\n" + TXT.bienvenida);
  }

  switch (sesion.paso) {
    case "esperando_aceptacion":
      if (m.startsWith("acepto")) {
        await db.guardarSesion(telefono, "esperando_tipo", { aceptoAt: new Date().toISOString() });
        return enviar(telefono, TXT.tipoPersona);
      }
      return enviar(telefono, "Para continuar necesitamos que responda *ACEPTO*. Si no desea seguir, no es necesario responder.");

    case "esperando_tipo":
      if (m === "1" || m === "2") {
        const tipoPersona = m === "1" ? "nat" : "jur";
        await db.guardarSesion(telefono, "esperando_nombre", { ...datos, tipoPersona });
        return enviar(telefono, tipoPersona === "nat" ? TXT.nombreNat : TXT.nombreJur);
      }
      return enviar(telefono, "Responda *1* para persona natural o *2* para empresa.");

    case "esperando_nombre": {
      const nombre = mensaje.trim().replace(/\s+/g, " ");
      if (nombre.length < 4 || (datos.tipoPersona === "nat" && nombre.split(" ").length < 2)) {
        return enviar(telefono, "Escriba el nombre completo, con al menos un nombre y un apellido.");
      }
      await db.guardarSesion(telefono, "esperando_documento", { ...datos, nombre });
      return enviar(telefono, datos.tipoPersona === "nat" ? TXT.docNat : TXT.docJur);
    }

    case "esperando_documento": {
      const esCE = datos.tipoPersona === "nat" && /^ce\b/.test(m);
      const documento = mensaje.replace(/\D/g, "");
      if (documento.length < 5 || documento.length > 15) {
        return enviar(telefono, "El número no parece válido. Escríbalo solo con números, sin puntos ni dígito de verificación.");
      }
      const tipoDocumento = datos.tipoPersona === "jur" ? "NIT" : esCE ? "CE" : "CC";
      return ejecutarConsulta(telefono, { ...datos, documento, tipoDocumento });
    }

    case "consultando":
      return enviar(telefono, TXT.sigueConsultando);

    case "esperando_pago": {
      const sol = datos.referencia && (await db.solicitudPorReferencia(datos.referencia));
      if (sol && sol.estado === "pendiente_pago") {
        const t = await wompi.transaccionAprobada(sol.referencia);
        if (t) return procesarPago(sol.referencia, t.id);
        return enviar(telefono,
          `Su enlace de pago sigue activo:\n${wompi.enlacePago(sol.referencia, sol.valor_centavos)}\n\n` +
          "Apenas Wompi confirme el pago le enviaremos el informe. Para hacer otra consulta, escriba *NUEVA*.");
      }
      await db.guardarSesion(telefono, "esperando_aceptacion", {});
      return enviar(telefono, TXT.bienvenida);
    }

    default:
      await db.guardarSesion(telefono, "esperando_aceptacion", {});
      return enviar(telefono, TXT.bienvenida);
  }
}

// ── Rutas ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Verifica que el mensaje venga de Twilio (si hay credenciales configuradas).
  if (TWILIO_AUTH_TOKEN && process.env.PUBLIC_BASE_URL) {
    const firma = req.get("X-Twilio-Signature") || "";
    if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, firma, BASE_URL + "/webhook", req.body)) {
      return res.status(403).send("Firma inválida");
    }
  }
  res.set("Content-Type", "text/xml").status(200).send("<Response></Response>");
  const telefono = (req.body.From || "").replace("whatsapp:+", "");
  const mensaje = (req.body.Body || "").trim();
  if (!telefono || !mensaje) return;
  try {
    await atender(telefono, mensaje);
  } catch (e) {
    console.error("Error atendiendo a", telefono, e.message);
    await enviar(telefono, "Tuvimos un problema técnico. Escriba *MENÚ* para empezar de nuevo o comuníquese al +57 313 829 1633.").catch(() => {});
  }
});

app.post("/wompi-webhook", async (req, res) => {
  res.json({ status: "ok" });
  try {
    const evento = req.body;
    if (!wompi.eventoValido(evento)) return console.warn("Evento Wompi con firma inválida, descartado.");
    const t = evento.data && evento.data.transaction;
    if (evento.event === "transaction.updated" && t && t.status === "APPROVED" && String(t.reference).startsWith("PJP-")) {
      const sol = await db.solicitudPorReferencia(t.reference);
      if (sol && Number(t.amount_in_cents) === Number(sol.valor_centavos)) await procesarPago(t.reference, t.id);
    }
  } catch (e) {
    console.error("Error en wompi-webhook:", e.message);
  }
});

app.get("/reporte/:token.pdf", async (req, res) => {
  try {
    const sol = await db.solicitudPorToken(req.params.token);
    if (!sol || !["pagado", "reporte_enviado", "complemento_enviado"].includes(sol.estado)) {
      return res.status(404).send("Reporte no encontrado");
    }
    const pdf = await generarPDF(sol);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Perfil-${sol.referencia}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error("Error generando reporte:", e.message);
    res.status(500).send("No fue posible generar el reporte");
  }
});

// Herramienta interna de la firma (Supernotariado)
app.use(require("./admin")({ db, enviar, BASE_URL }));

app.get("/", (req, res) => res.send("Perfil Jurídico y Patrimonial activo."));

// Diagnóstico: indica qué está configurado y si la base de datos responde (no expone secretos).
app.get("/salud", async (req, res) => {
  const estado = {
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_llave: !!process.env.SUPABASE_SERVICE_KEY,
    twilio: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_NUMBER),
    wompi_publica: !!process.env.WOMPI_PUBLIC_KEY,
    wompi_integridad: !!process.env.WOMPI_INTEGRITY_KEY,
    wompi_eventos: !!process.env.WOMPI_EVENTS_SECRET,
    wompi_privada: !!process.env.WOMPI_PRIVATE_KEY,
    wompi_modo: (process.env.WOMPI_PUBLIC_KEY || "").startsWith("pub_test") ? "pruebas" : (process.env.WOMPI_PUBLIC_KEY ? "produccion" : "sin configurar"),
    admin_clave: !!process.env.ADMIN_CLAVE,
    base_publica: BASE_URL,
  };
  try {
    await db.solicitudesPendientesDePago(1);
    estado.base_de_datos = "conectada";
  } catch (e) {
    estado.base_de_datos = "error " + ((e.response && e.response.status) || "") + " " + ((e.response && e.response.data && (e.response.data.message || e.response.data.hint)) || e.message);
  }
  res.json(estado);
});

// Respaldo: cada 3 minutos revisa en Wompi los pagos que no hayan llegado por aviso.
async function revisarPagos() {
  try {
    for (const { referencia } of await db.solicitudesPendientesDePago(24)) {
      const t = await wompi.transaccionAprobada(referencia);
      if (t) await procesarPago(referencia, t.id);
    }
  } catch (e) {
    console.error("Error en revisión de pagos:", e.message);
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log("Servidor en puerto " + PORT));
  setInterval(revisarPagos, 3 * 60 * 1000);
}
module.exports = { app, atender, procesarPago };

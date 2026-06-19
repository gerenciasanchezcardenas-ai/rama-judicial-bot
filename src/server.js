require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const PRECIO_CONSULTA = 2000000;

const sesiones = {};
const pagosEsperados = {};

// Explicaciones por tipo de proceso
const EXPLICACIONES_PROCESO = {
  "EJECUTIVO": "En este proceso se busca el cobro de una obligación económica. Es susceptible de embargo a su patrimonio (cuentas bancarias, bienes inmuebles, vehículos). Se recomienda atención inmediata.",
  "ORDINARIO": "Este proceso busca la declaración o reconocimiento de derechos. Puede afectar sus bienes, contratos o relaciones jurídicas según lo que se pretenda en la demanda.",
  "LABORAL": "Una persona o extrabajador reclama derechos laborales (salarios, prestaciones, indemnizaciones). En caso de condena, puede implicar pagos económicos significativos.",
  "TUTELA": "Se solicita la protección de derechos fundamentales. Requiere respuesta urgente pues los fallos son de cumplimiento inmediato.",
  "PENAL": "Existe una investigación o acusación de carácter criminal. Puede implicar medidas de aseguramiento o restricciones a su libertad.",
  "FAMILIA": "Proceso relacionado con alimentos, custodia, divorcio o filiación. Puede generar obligaciones económicas o afectar relaciones familiares.",
  "ADMINISTRATIVO": "Demanda contra una entidad pública o del Estado. Puede involucrar reclamaciones patrimoniales o anulación de actos administrativos.",
  "VERBAL": "Proceso de conocimiento verbal para resolver controversias de menor cuantía o asuntos específicos. Requiere defensa técnica.",
  "SUCESION": "Proceso de liquidación de herencia o patrimonio de una persona fallecida. Afecta la distribución de bienes entre herederos.",
  "HIPOTECARIO": "Proceso para hacer efectiva una garantía hipotecaria. Su bien inmueble puede estar en riesgo de remate judicial.",
  "DECLARATIVO": "Se busca que el juez declare la existencia o inexistencia de un derecho o situación jurídica.",
};

function obtenerExplicacion(tipoProceso) {
  if (!tipoProceso) return "Proceso judicial activo que requiere atención. Consulte con un abogado para conocer su situación específica.";
  const tipo = tipoProceso.toUpperCase();
  for (const [key, val] of Object.entries(EXPLICACIONES_PROCESO)) {
    if (tipo.includes(key)) return val;
  }
  return "Proceso judicial activo registrado en la Rama Judicial de Colombia. Se recomienda consultar con un abogado para determinar su situación procesal.";
}

async function enviarMensaje(telefono, texto) {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const params = new URLSearchParams();
    params.append("From", TWILIO_WHATSAPP_NUMBER);
    params.append("To", "whatsapp:+" + telefono);
    params.append("Body", texto);
    await axios.post(url, params, {
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
  } catch (e) {
    console.error("Error enviando mensaje:", e.message, e.response && JSON.stringify(e.response.data));
  }
}

async function enviarPDF(telefono, pdfPath, termino) {
  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const fileBuffer = fs.readFileSync(pdfPath);
    const fileName = path.basename(pdfPath);

    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", fileBuffer, { filename: fileName, contentType: "application/pdf" });
    const uploadResponse = await axios.post("https://file.io/?expires=1d", form, {
      headers: { ...form.getHeaders() },
      timeout: 30000
    });
    const pdfUrl = uploadResponse.data && uploadResponse.data.link;
    if (!pdfUrl) throw new Error("No se obtuvo URL del PDF");

    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: "whatsapp:+" + telefono,
      body: "📄 Reporte de procesos judiciales para *" + termino + "*",
      mediaUrl: [pdfUrl]
    });
    console.log("PDF enviado:", pdfUrl);
  } catch (e) {
    console.error("Error enviando PDF:", e.message);
    await enviarMensaje(telefono, "⚠️ No se pudo adjuntar el PDF. Por favor contáctenos: gerenciasanchezcardenas@gmail.com");
  }
}
function generarPDF(termino, procesos, cantidad) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const fileName = `reporte_${Date.now()}.pdf`;
    const filePath = `/tmp/${fileName}`;
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Colores
    const NAVY = "#0d1b2a";
    const GOLD = "#b8973a";
    const CREAM = "#f9f6ef";
    const GRAY = "#666666";

    // Header
    doc.rect(0, 0, doc.page.width, 120).fill(NAVY);
    doc.fillColor(GOLD).fontSize(22).font("Helvetica-Bold")
      .text("SÁNCHEZ & CÁRDENAS CONSULTING S.A.S.", 50, 30);
    doc.fillColor(CREAM).fontSize(11).font("Helvetica")
      .text("Derecho Corporativo & Consultoría Legal", 50, 58);
    doc.fillColor(GOLD).fontSize(10)
      .text("sanchezcardenasconsulting.com  |  gerenciasanchezcardenas@gmail.com", 50, 76);

    // Línea dorada
    doc.rect(0, 120, doc.page.width, 4).fill(GOLD);

    // Título del reporte
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold")
      .text("REPORTE DE PROCESOS JUDICIALES", 50, 145, { align: "center" });
    doc.fillColor(GRAY).fontSize(11).font("Helvetica")
      .text("Consultado: " + termino.toUpperCase(), 50, 168, { align: "center" });
    doc.fillColor(GRAY).fontSize(10)
      .text("Fecha: " + new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" }), 50, 185, { align: "center" });
    doc.fillColor(GRAY).fontSize(10)
      .text("Total de procesos registrados: " + cantidad, 50, 200, { align: "center" });

    // Línea separadora
    doc.moveTo(50, 220).lineTo(doc.page.width - 50, 220).strokeColor(GOLD).lineWidth(1).stroke();

    // Procesos activos
    const activos = procesos.filter(p => p.fechaUltimaActuacion || p.esPrivado === false);
    let y = 235;

    doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold")
      .text("PROCESOS ACTIVOS (" + activos.length + ")", 50, y);
    y += 20;

    if (activos.length === 0) {
      doc.fillColor(GRAY).fontSize(11).font("Helvetica")
        .text("No se encontraron procesos activos en esta consulta.", 50, y);
      y += 20;
    }

    for (let i = 0; i < activos.length; i++) {
      const p = activos[i];

      // Verificar si necesita nueva página
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = 50;
      }

      // Caja del proceso
      doc.rect(50, y, doc.page.width - 100, 8).fill(NAVY);
      y += 12;

      doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold")
        .text((i + 1) + ". " + (p.tipoProceso || "Proceso Judicial"), 55, y);
      y += 16;

      doc.fillColor(GRAY).fontSize(9).font("Helvetica")
        .text("Radicado: ", 55, y, { continued: true })
        .fillColor(NAVY).font("Helvetica-Bold")
        .text(p.llaveProceso || "N/A", { continued: false });
      y += 13;

      doc.fillColor(GRAY).fontSize(9).font("Helvetica")
        .text("Despacho: ", 55, y, { continued: true })
        .fillColor(NAVY).font("Helvetica-Bold")
        .text(p.despacho || "N/A", { continued: false });
      y += 13;
      const sujetos = Array.isArray(p.sujetosProcesales) ? p.sujetosProcesales : [];
      if (sujetos.length > 0) {
        const demandante = sujetos.find(s => s.tipoSujeto && s.tipoSujeto.toLowerCase().includes("demandante"));
        const demandado = sujetos.find(s => s.tipoSujeto && s.tipoSujeto.toLowerCase().includes("demandado"));        if (demandante) {
          doc.fillColor(GRAY).fontSize(9).font("Helvetica")
            .text("Demandante: ", 55, y, { continued: true })
            .fillColor(NAVY).font("Helvetica-Bold")
            .text(demandante.nombre || "N/A", { continued: false });
          y += 13;
        }
        if (demandado) {
          doc.fillColor(GRAY).fontSize(9).font("Helvetica")
            .text("Demandado: ", 55, y, { continued: true })
            .fillColor(NAVY).font("Helvetica-Bold")
            .text(demandado.nombre || "N/A", { continued: false });
          y += 13;
        }
      }

      doc.fillColor(GRAY).fontSize(9).font("Helvetica")
        .text("Última actuación: ", 55, y, { continued: true })
        .fillColor(NAVY).font("Helvetica-Bold")
        .text((p.fechaUltimaActuacion || p.fechaProceso || "N/A").substring(0, 10), { continued: false });
      y += 13;

      // Explicación
      const explicacion = obtenerExplicacion(p.tipoProceso);
      doc.rect(55, y, doc.page.width - 110, 2).fill("#e8e8e8");
      y += 6;
      doc.fillColor(GOLD).fontSize(9).font("Helvetica-Bold").text("⚠️ ¿Qué significa este proceso?", 55, y);
      y += 13;
      doc.fillColor(GRAY).fontSize(9).font("Helvetica")
        .text(explicacion, 55, y, { width: doc.page.width - 110 });
      y += doc.heightOfString(explicacion, { width: doc.page.width - 110 }) + 8;
      y += 10;
    }

    // Footer con CTA
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = 50;
    }

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(GOLD).lineWidth(1).stroke();
    y += 15;

    doc.rect(50, y, doc.page.width - 100, 80).fill("#f0ece0");
    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold")
      .text("¿Necesita asesoría jurídica?", 60, y + 10);
    doc.fillColor(GRAY).fontSize(10).font("Helvetica")
      .text("Nuestros abogados pueden representarle y proteger sus derechos en cualquiera de estos procesos.", 60, y + 26, { width: doc.page.width - 120 });
    doc.fillColor(GOLD).fontSize(10).font("Helvetica-Bold")
      .text("👉 Agende su asesoría virtual: sanchezcardenasconsulting.com/#asesoria", 60, y + 52);
    doc.fillColor(GRAY).fontSize(9).font("Helvetica")
      .text("gerenciasanchezcardenas@gmail.com  |  +57 313 829 1633", 60, y + 66);

    // Footer final
    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(NAVY);
    doc.fillColor(GOLD).fontSize(8).font("Helvetica")
      .text("Sánchez & Cárdenas Consulting S.A.S.  |  Bogotá, Colombia  |  www.sanchezcardenasconsulting.com", 50, doc.page.height - 26, { align: "center" });

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

async function crearEnlacePago(referencia) {
  const integrity = crypto.createHash("sha256")
    .update(referencia + PRECIO_CONSULTA + "COP" + WOMPI_INTEGRITY_KEY)
    .digest("hex");
  return "https://checkout.wompi.co/p/?public-key=" + process.env.WOMPI_PUBLIC_KEY + "&currency=COP&amount-in-cents=" + PRECIO_CONSULTA + "&reference=" + referencia + "&signature:integrity=" + integrity;
}

app.post("/webhook", async (req, res) => {
  res.set("Content-Type", "text/xml").status(200).send("<Response></Response>");
  try {
    const body = req.body;
    console.log("Webhook recibido:", JSON.stringify(body));
    const telefono = (body.From || "").replace("whatsapp:+", "");
    const mensaje = (body.Body || "").trim();
    if (!telefono || !mensaje) return;

    if (mensaje.toLowerCase().startsWith("join")) {
      await enviarMensaje(telefono, "Bienvenido a Sanchez & Cardenas Consulting! 👋\n\nPuede iniciar la consulta de procesos judiciales en la Rama Judicial de Colombia escribiendo *Hola*.\n\nSi requiere asesoria juridica inmediata, escribanos al correo: gerenciasanchezcardenas@gmail.com\n\nEstamos para servirle.");
      return;
    }

    if (["reiniciar", "menu", "menú", "inicio"].includes(mensaje.toLowerCase())) {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "Sesion reiniciada. Hola! Soy el asistente de Sanchez & Cardenas Consulting. Desea consultar procesos judiciales activos? Responda SI para continuar.");
      return;
    }

    const sesion = sesiones[telefono] || { paso: "inicio" };
    let respuesta = "";

    if (sesion.paso === "inicio") {
      respuesta = "Hola! Soy el asistente de Sanchez & Cardenas Consulting. Desea consultar procesos judiciales activos? Responda SI para continuar.";
      sesiones[telefono] = { paso: "esperando_confirmacion" };
    } else if (sesion.paso === "esperando_confirmacion") {
      if (mensaje.toLowerCase().includes("si")) {
        respuesta = "Desea consultar por: 1. Nombre o Razon Social  2. Numero de Radicado. Responda 1 o 2.";
        sesiones[telefono] = { paso: "esperando_tipo_consulta" };
      } else {
        respuesta = "Entendido. Si necesita consultar en otro momento, escribame.";
        sesiones[telefono] = { paso: "inicio" };
      }
    } else if (sesion.paso === "esperando_tipo_consulta") {
      if (mensaje === "1") {
        respuesta = "El sujeto procesal es: 1. Persona Natural  2. Persona Juridica. Responda 1 o 2.";
        sesiones[telefono] = { paso: "esperando_tipo_persona" };
      } else if (mensaje === "2") {
        respuesta = "Por favor ingrese el numero de radicado del proceso:";
        sesiones[telefono] = { paso: "esperando_radicado_previo" };
      } else {
        respuesta = "Por favor responda 1 para Nombre o 2 para Radicado.";
      }
    } else if (sesion.paso === "esperando_tipo_persona") {
      if (mensaje === "1") {
        respuesta = "Por favor ingrese el nombre completo de la persona natural:";
        sesiones[telefono] = { paso: "esperando_nombre_previo", tipoPersona: "nat" };
      } else if (mensaje === "2") {
        respuesta = "Por favor ingrese la razon social de la empresa:";
        sesiones[telefono] = { paso: "esperando_nombre_previo", tipoPersona: "jur" };
      } else {
        respuesta = "Por favor responda 1 para Natural o 2 para Juridica.";
      }
    } else if (sesion.paso === "esperando_nombre_previo") {
      const tipoPersona = sesion.tipoPersona || "nat";
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorNombre(mensaje, tipoPersona);
      if (!resultado.tieneProcesos) {
        respuesta = resultado.mensaje;
      } else {
        const referencia = "SC-" + telefono + "-" + Date.now();
        pagosEsperados[referencia] = { telefono, termino: mensaje, procesos: resultado.procesos || [], cantidad: resultado.cantidad, detalle: resultado.detalle };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = resultado.resumenPrevio + "\n\n💳 Para ver el detalle completo realice el pago de $20.000 COP: " + enlace;
      }
    } else if (sesion.paso === "esperando_radicado_previo") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(mensaje);
      if (!resultado.tieneProcesos) {
        respuesta = resultado.mensaje;
      } else {
        const referencia = "SC-" + telefono + "-" + Date.now();
        pagosEsperados[referencia] = { telefono, termino: mensaje, procesos: resultado.procesos || [], cantidad: resultado.cantidad, detalle: resultado.detalle };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = resultado.resumenPrevio + "\n\n💳 Para ver el detalle completo realice el pago de $20.000 COP: " + enlace;
      }
    } else if (sesion.paso === "esperando_pago") {
      respuesta = "Su pago esta siendo procesado. Una vez confirmado recibira el detalle de los procesos. Si ya pago y no ha recibido respuesta, contactenos: +57 313 829 1633";
    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Hola! Soy el asistente de Sanchez & Cardenas Consulting. Desea consultar procesos judiciales activos? Responda SI para continuar.";
    }

    if (respuesta) await enviarMensaje(telefono, respuesta);
  } catch (err) {
    console.error("Error en webhook:", err.message);
  }
});

app.post("/wompi-webhook", async (req, res) => {
  res.json({ status: "ok" });
  try {
    const evento = req.body;
    if (evento && evento.event === "transaction.updated") {
      const txn = evento.data && evento.data.transaction;
      if (txn && txn.status === "APPROVED") {
        const referencia = txn.reference;
        const pago = pagosEsperados[referencia];
        if (pago) {
          await enviarMensaje(pago.telefono, "✅ Pago confirmado! Generando su reporte de procesos judiciales... un momento.");
          try {
            const pdfPath = await generarPDF(pago.termino, pago.procesos, pago.cantidad);
            await enviarPDF(pago.telefono, pdfPath, pago.termino);
            // Limpiar archivo temporal
            setTimeout(() => { try { fs.unlinkSync(pdfPath); } catch(e) {} }, 60000);
          } catch (pdfError) {
            console.error("Error generando PDF:", pdfError.message);
            await enviarMensaje(pago.telefono, "Pago confirmado! Aqui esta el detalle de los procesos:\n\n" + pago.detalle);
          }
          delete pagosEsperados[referencia];
        }
      }
    }
  } catch (err) {
    console.error("Error en wompi-webhook:", err.message);
  }
});

app.get("/", (req, res) => res.send("Bot Rama Judicial activo."));
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));

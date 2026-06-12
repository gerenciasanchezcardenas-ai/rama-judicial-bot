require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.D360_API_KEY;
const API_URL = "https://waba-sandbox.360dialog.io/v1/messages";
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const PRECIO_CONSULTA = 2000000;

const sesiones = {};
const pagosEsperados = {};

async function enviarMensaje(telefono, texto) {
  try {
    await axios.post(API_URL, {
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: texto },
    }, { headers: { "D360-API-KEY": API_KEY, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Error enviando mensaje:", e.message);
  }
}

async function crearEnlacePago(referencia) {
  const integrity = crypto.createHash("sha256")
    .update(referencia + PRECIO_CONSULTA + "COP" + WOMPI_INTEGRITY_KEY)
    .digest("hex");
  return "https://checkout.wompi.co/p/?public-key=" + process.env.WOMPI_PUBLIC_KEY + "&currency=COP&amount-in-cents=" + PRECIO_CONSULTA + "&reference=" + referencia + "&signature:integrity=" + integrity;
}

app.post("/webhook", async (req, res) => {
  res.json({ status: "ok" });
  try {
    const entry = req.body && req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const mensaje_obj = value && value.messages && value.messages[0];
    if (!mensaje_obj || mensaje_obj.type !== "text") return;
    const telefono = mensaje_obj.from;
    const mensaje = mensaje_obj.text.body.trim();const sesion = sesiones[telefono] || { paso: "inicio" };
    let respuesta = "";
    if (sesion.paso === "inicio") {
      respuesta = "Hola! Soy el asistente de Sanchez & Cardenas Consulting.\n\nDesea consultar procesos judiciales activos?\n\nResponda SI para continuar.";
      sesiones[telefono] = { paso: "esperando_confirmacion" };
    } else if (sesion.paso === "esperando_confirmacion") {
      if (mensaje.toLowerCase().includes("si")) {
        respuesta = "Desea consultar por:\n\n1. Nombre o Razon Social\n2. Numero de Radicado\n\nResponda 1 o 2.";
        sesiones[telefono] = { paso: "esperando_tipo_consulta" };
      } else {
        respuesta = "Entendido. Si necesita consultar en otro momento, escribame.";
        sesiones[telefono] = { paso: "inicio" };
      }
    } else if (sesion.paso === "esperando_tipo_consulta") {
      if (mensaje === "1") {
        respuesta = "El sujeto procesal es:\n\n1. Persona Natural\n2. Persona Juridica\n\nResponda 1 o 2.";
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
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(mensaje);
      if (!resultado.tieneProcesos) {
        respuesta = resultado.mensaje;
      } else {
        const referencia = "SC-" + telefono + "-" + Date.now();
        pagosEsperados[referencia] = { telefono: telefono, detalle: resultado.detalle };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = "Se encontraron " + resultado.cantidad + " proceso(s) para el radicado " + mensaje + ".\n\nPara ver el detalle realice el pago de $20.000 COP:\n\n" + enlace;
      }
    } else if (sesion.paso === "esperando_pago") {
      if (mensaje.toUpperCase() === "CANCELAR") {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = "Consulta cancelada. Escriba cualquier mensaje para iniciar de nuevo.";
      } else {
        respuesta = "Su pago aun no ha sido confirmado. Complete el pago en el enlace enviado o escriba CANCELAR para iniciar de nuevo.";
      }
    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Escriba cualquier mensaje para iniciar la consulta.";
    }
    if (respuesta) await enviarMensaje(telefono, respuesta);
  } catch (e) {
    console.error("Error en webhook:", e.message);
  }
});app.post("/wompi/eventos", async (req, res) => {
  res.json({ status: "ok" });
  try {
    const evento = req.body;
    if (!evento || evento.event !== "transaction.updated") return;
    const transaccion = evento.data && evento.data.transaction;
    if (!transaccion || transaccion.status !== "APPROVED") return;
    const referencia = transaccion.reference;
    const consulta = pagosEsperados[referencia];
    if (!consulta) return;
    delete pagosEsperados[referencia];
    sesiones[consulta.telefono] = { paso: "inicio" };
    await enviarMensaje(consulta.telefono, "Pago confirmado. Aqui estan los resultados:\n\n" + consulta.detalle);
  } catch (e) {
    console.error("Error en webhook Wompi:", e.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ estado: "OK", servicio: "Sanchez & Cardenas Bot Rama Judicial", hora: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log("Servidor activo en http://localhost:" + PORT);
});

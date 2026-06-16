require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
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

async function crearEnlacePago(referencia) {
  const integrity = crypto.createHash("sha256")
    .update(referencia + PRECIO_CONSULTA + "COP" + WOMPI_INTEGRITY_KEY)
    .digest("hex");
  return "https://checkout.wompi.co/p/?public-key=" + process.env.WOMPI_PUBLIC_KEY + "&currency=COP&amount-in-cents=" + PRECIO_CONSULTA + "&reference=" + referencia + "&signature:integrity=" + integrity;
}

app.post("/webhook", async (req, res) => {
  res.set('Content-Type', 'text/xml').status(200).send('<Response></Response>');
  try {
    const body = req.body;
    console.log("Webhook recibido:", JSON.stringify(body));

    const telefono = (body.From || "").replace("whatsapp:+", "");
    const mensaje = (body.Body || "").trim();

    if (!telefono || !mensaje) return;

    // Palabra clave para reiniciar sesión
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
        pagosEsperados[referencia] = { telefono, detalle: resultado.detalle };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = "Se encontraron " + resultado.cantidad + " proceso(s) para " + mensaje + ". Para ver el detalle realice el pago de $20.000 COP: " + enlace;
      }
    } else if (sesion.paso === "esperando_radicado_previo") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(mensaje);
      if (!resultado.tieneProcesos) {
        respuesta = resultado.mensaje;
      } else {
        const referencia = "SC-" + telefono + "-" + Date.now();
        pagosEsperados[referencia] = { telefono, detalle: resultado.detalle };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = "Se encontro el proceso para el radicado " + mensaje + ". Para ver el detalle realice el pago de $20.000 COP: " + enlace;
      }
    } else if (sesion.paso === "esperando_pago") {
      respuesta = "Su pago esta siendo procesado. Una vez confirmado recibira el detalle de los procesos. Si ya pago y no ha recibido respuesta, contactenos: +57 313 829 1633";
    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Hola! Soy el asistente de Sanchez & Cardenas Consulting. Desea consultar procesos judiciales activos? Responda SI para continuar.";
    }

    if (respuesta) {
      await enviarMensaje(telefono, respuesta);
    }
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
          await enviarMensaje(pago.telefono, "Pago confirmado! Aqui esta el detalle de los procesos:\n\n" + pago.detalle);
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

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.D360_API_KEY;
const API_URL = "https://waba-sandbox.360dialog.io/v1/messages";

const sesiones = {};

async function enviarMensaje(telefono, texto) {
  await axios.post(
    API_URL,
    {
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: texto },
    },
    { headers: { "D360-API-KEY": API_KEY, "Content-Type": "application/json" } }
  );
}

app.post("/webhook", async (req, res) => {
  res.json({ status: "ok" });

  try {
    const mensaje_obj = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje_obj || mensaje_obj.type !== "text") return;

    const telefono = mensaje_obj.from;
    const mensaje = mensaje_obj.text.body.trim();
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
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorNombre(mensaje, tipoPersona);
      respuesta = resultado.mensaje;

    } else if (sesion.paso === "esperando_radicado") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(mensaje);
      respuesta = resultado.mensaje;

    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Escriba cualquier mensaje para iniciar la consulta.";
    }

    if (respuesta) await enviarMensaje(telefono, respuesta);

  } catch (e) {
    console.error("Error en webhook:", e.message);
  }
});

app.get("/health", (req, res) =>
  res.json({ estado: "OK", servicio: "Sánchez & Cárdenas – Bot Rama Judicial", hora: new Date().toISOString() })
);

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

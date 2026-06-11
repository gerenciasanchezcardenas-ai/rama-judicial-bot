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
  res.json({ status: "ok" }); // responder 200 inmediatamente

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const mensaje_obj = value?.messages?.[0];

    if (!mensaje_obj || mensaje_obj.type !== "text") return;

    const telefono = mensaje_obj.from;
    const mensaje = mensaje_obj.text.body.trim();
    const sesion = sesiones[telefono] || { paso: "inicio" };

    let respuesta = "";

    if (sesion.paso === "inicio") {
      respuesta = "¡Hola! 👋 Soy el asistente de *Sánchez & Cárdenas Consulting*.\n\n¿Desea consultar si tiene procesos judiciales activos? Responda *SÍ* para continuar.";
      sesiones[telefono] = { paso: "esperando_confirmacion" };

    } else if (sesion.paso === "esperando_confirmacion") {
      if (mensaje.toLowerCase().includes("sí") || mensaje.toLowerCase().includes("si")) {
        respuesta = "Por favor ingrese su *nombre completo* o el *número de radicado* del proceso.";
        sesiones[telefono] = { paso: "esperando_nombre" };
      } else {
        respuesta = "Entendido. Si necesita consultar en otro momento, escríbame.";
        sesiones[telefono] = { paso: "inicio" };
      }

    } else if (sesion.paso === "esperando_nombre") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");

      const esNum = /^\d{6,15}$/.test(mensaje.replace(/\s/g, ""));
      const resultado = esNum
        ? await consultarPorRadicado(mensaje)
        : await consultarPorNombre(mensaje);

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

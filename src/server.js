require("dotenv").config();
const express = require("express");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const sesiones = {};

app.post("/webhook/twilio", async (req, res) => {
  const mensaje = (req.body.Body || "").trim();
  const telefono = req.body.From || "";
  const sesion = sesiones[telefono] || { paso: "inicio" };
  let respuesta = "";

  if (sesion.paso === "inicio") {
    respuesta = "¡Hola! 👋 Soy el asistente de *Sánchez & Cárdenas Consulting*.\n\n¿Desea consultar si tiene procesos judiciales activos? Responda *SÍ* para continuar.";
    sesiones[telefono] = { paso: "esperando_confirmacion" };
  } else if (sesion.paso === "esperando_confirmacion") {
    if (mensaje.toLowerCase().includes("si") || mensaje.toLowerCase().includes("sí")) {
      respuesta = "Por favor indíquenos el *nombre completo* o *número de cédula* a consultar.";
      sesiones[telefono] = { paso: "esperando_nombre" };
    } else {
      respuesta = "Entendido. Estamos disponibles cuando lo necesite.\n\n_Sánchez & Cárdenas Consulting_\n📞 +57 313 829 1633";
      delete sesiones[telefono];
    }
  } else if (sesion.paso === "esperando_nombre") {
    sesiones[telefono] = { paso: "inicio" };
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>⏳ Consultando en la Rama Judicial... un momento.</Message></Response>`);
    try {
      const esNum = /^\d{6,15}$/.test(mensaje.replace(/\s/g, ""));
      const resultado = esNum ? await consultarPorRadicado(mensaje) : await consultarPorNombre(mensaje);
      const axios = require("axios");
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
        new URLSearchParams({ From: process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886", To: telefono, Body: resultado.mensaje }),
        { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } }
      );
    } catch (e) { console.error("Error:", e.message); }
    return;
  } else {
    sesiones[telefono] = { paso: "inicio" };
    respuesta = "Escriba cualquier mensaje para iniciar la consulta.";
  }

  res.set("Content-Type", "text/xml");
  res.send(`<Response><Message>${respuesta}</Message></Response>`);
});

app.get("/health", (req, res) => res.json({ estado: "OK", servicio: "Sánchez & Cárdenas — Bot Rama Judicial", hora: new Date().toISOString() }));

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

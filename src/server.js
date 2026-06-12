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
  } catch (e) {
    console.error("Error enviando mensaje:", e.message);
  }
}

async function crearEnlacePago(referencia) {
  const integrity = crypto
    .createHash("sha256")
    .update(`${referencia}${PRECIO_CONSULTA}COP${WOMPI_INTEGRITY_KEY}`)
    .digest("hex");
  return `https://checkout.wompi.co/p/?public-key=${process.env.WOMPI_PUBLIC_KEY}&currency=COP&amount-in-cents=${PRECIO_CONSULTA}&reference=${referencia}&signature:integrity=${integrity}`;
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
        sesiones[telefono] = { paso: "esperando_radicado_previo" };
      } else {
        respuesta = "Por favor responda *1* para Nombre o *2* para Radicado.";
      }

    } else if (sesion.paso === "esperando_tipo_persona") {
      if (mensaje === "1") {
        respuesta = "Por favor ingrese el *nombre completo* de la persona natural:";
        sesiones[telefono] = { paso: "esperando_nombre_previo", tipoPersona: "nat" };
      } else if (mensaje === "2") {
        respuesta = "Por favor ingrese la *razón social* de la empresa:";
        sesiones[telefono] = { paso: "esperando_nombre_previo", tipoPersona: "jur" };
      } else {
        respuesta = "Por favor responda *1* para Natural o *2* para Jurídica.";
      }

    } else if (sesion.paso === "esperando_nombre_previo") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const tipoPersona = sesion.tipoPersona || "nat";
      const resultado = await consultarPorNombre(mensaje, tipoPersona);

      if (!resultado.tieneProcesos) {
        respuesta = `📋 *No se encontraron procesos* registrados para *${mensaje}* en la Rama Judicial.`;
      } else {
        const referencia = `SC-${telefono}-${Date.now()}`;
        pagosEsperados[referencia] = {
          telefono,
          tipoConsulta: "nombre",
          tipoPersona,
          termino: mensaje,
          detalle: resultado.detalle,
        };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = `✅ Se encontraron *${resultado.cantidad}* proceso(s) para *${mensaje}*.\n\n💳 Para ver el detalle completo, realice el pago de *$20.000 COP*:\n\n🔗 ${enlace}\n\nUna vez completado el pago recibirá los resultados automáticamente.`;
      }

    } else if (sesion.paso === "esperando_radicado_previo") {
      sesiones[telefono] = { paso: "inicio" };
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorRadicado(mensaje);

      if (!resultado.tieneProcesos) {
        respuesta = `📋 *No se encontraron procesos* registrados para el radicado *${mensaje}* en la Rama Judicial.`;
      } else {
        const referencia = `SC-${telefono}-${Date.now()}`;
        pagosEsperados[referencia] = {
          telefono,
          tipoConsulta: "radicado",
          termino: mensaje,
          detalle: resultado.detalle,
        };
        const enlace = await crearEnlacePago(referencia);
        sesiones[telefono] = { paso: "esperando_pago" };
        respuesta = `✅ Se encontraron *${resultado.cantidad}* proceso(s) para el radicado *${mensaje}*.\n\n💳 Para ver el detalle completo, realice el pago de *$20.000 COP*:\n\n🔗 ${enlace}\n\nUna vez completado el pago recibirá los resultados automáticamente.`;
      }

    } else if (sesion.paso === "esperando_pago") {
      if (mensaje.toUpperCase() === "CANCELAR") {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = "Consulta cancelada. Escriba cualquier mensaje para iniciar de nuevo.";
      } else {
        respuesta = "⏳ Su pago aún no ha sido confirmado. Complete el pago en el enlace enviado o escriba *CANCELAR* para iniciar de nuevo.";
      }

    } else {
      sesiones[telefono] = { paso: "inicio" };
      respuesta = "Escriba cualquier mensaje para iniciar la consulta.";
    }

    if (respuesta) await enviarMensaje(telefono, respuesta);

  } catch (e) {
    console.error("Error en webhook:", e.message);
  }
});

app.post("/wompi/eventos", async (req, res) => {
  res.json({ status: "ok" });

  try {
    const evento = req.body;
    if (evento?.event !== "transaction.updated") return;
    const transaccion = evento.data?.transaction;
    if (transaccion?.status !== "APPROVED") return;

    const referencia = transaccion.reference;
    const consulta = pagosEsperados[referencia];
    if (!consulta) return;

    delete pagosEsperados[referencia];
    sesiones[consulta.telefono] = { paso: "inicio" };

    await enviarMensaje(consulta.telefono, "✅ *Pago confirmado.* Aquí están los resultados:\n\n" + consulta.detalle);

  } catch (e) {
    console.error("Error en webhook Wompi:", e.message);
  }
});

app.get("/health", (req, res) =>
  res.json({ estado: "OK", servicio: "Sánchez & Cárdenas – Bot Rama Judicial", hora: new Date().toISOString() })
);

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { consultarPorNombre, consultarPorRadicado, obtenerActuaciones, linkMicrositio } = require("./src/ramaJudicial");

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
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");
      const resultado = await consultarPorNombre(mensaje, tipoPersona);

      if (!resultado.tieneProcesos || resultado.procesos.length === 0) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = resultado.mensaje || "No se encontraron procesos para ese nombre.";
      } else if (resultado.procesos.length === 1) {
        // Solo un proceso: ir directo a actuaciones
        const proceso = resultado.procesos[0];
        sesiones[telefono] = { paso: "inicio" };
        await enviarMensaje(telefono, "⏳ Cargando actuaciones...");
        const actuaciones = await obtenerActuaciones(proceso.idProceso, 7);
        if (!actuaciones || actuaciones.length === 0) {
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          sesiones[telefono] = { paso: "esperando_seleccion_actuacion", radicado: proceso.llaveProceso, idProceso: proceso.idProceso, actuaciones };
          let msg = `📋 *Actuaciones — ${proceso.llaveProceso}*\nDespacho: ${proceso.despacho || "N/A"}\n\n`;
          for (let i = 0; i < actuaciones.length; i++) {
            const a = actuaciones[i];
            msg += `*${i + 1}.* ${a.actuacion}\n   📅 ${a.fechaActuacion || "Sin fecha"}\n`;
            if (a.anotacion) msg += `   📝 ${a.anotacion.substring(0, 80)}${a.anotacion.length > 80 ? "..." : ""}\n`;
            msg += "\n";
          }
          msg += `Responda el *número* de la actuación para ver el documento, o *0* para salir.`;
          respuesta = msg;
        }
      } else {
        // Varios procesos: mostrarlos numerados para que el usuario elija
        const lista = resultado.procesos.slice(0, 8);
        sesiones[telefono] = { paso: "esperando_seleccion_proceso", procesos: lista };
        let msg = `✅ Se encontraron *${resultado.cantidad}* proceso(s) para ese nombre.\n\n`;
        msg += `Mostrando los primeros ${lista.length}:\n\n`;
        for (let i = 0; i < lista.length; i++) {
          const p = lista[i];
          msg += `*${i + 1}.* ${p.llaveProceso || "N/A"}\n`;
          msg += `   Despacho: ${(p.despacho || "N/A").substring(0, 60)}\n`;
          msg += `   Fecha: ${(p.fechaProceso || "").substring(0, 10) || "N/A"}\n\n`;
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
        const actuaciones = await obtenerActuaciones(proceso.idProceso, 7);
        if (!actuaciones || actuaciones.length === 0) {
          sesiones[telefono] = { paso: "inicio" };
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          sesiones[telefono] = { paso: "esperando_seleccion_actuacion", radicado: proceso.llaveProceso, idProceso: proceso.idProceso, actuaciones };
          let msg = `📋 *Actuaciones — ${proceso.llaveProceso}*\nDespacho: ${proceso.despacho || "N/A"}\n\n`;
          for (let i = 0; i < actuaciones.length; i++) {
            const a = actuaciones[i];
            msg += `*${i + 1}.* ${a.actuacion}\n   📅 ${a.fechaActuacion || "Sin fecha"}\n`;
            if (a.anotacion) msg += `   📝 ${a.anotacion.substring(0, 80)}${a.anotacion.length > 80 ? "..." : ""}\n`;
            msg += "\n";
          }
          msg += `Responda el *número* de la actuación para ver el documento, o *0* para salir.`;
          respuesta = msg;
        }
      }

    } else if (sesion.paso === "esperando_radicado") {
      const radicado = mensaje.replace(/\s/g, "");
      await enviarMensaje(telefono, "⏳ Consultando en la Rama Judicial... un momento.");

      // Primero buscamos el proceso para obtener idProceso
      const resultado = await consultarPorRadicado(radicado);

      if (!resultado.tieneProcesos || resultado.procesos.length === 0) {
        sesiones[telefono] = { paso: "inicio" };
        respuesta = resultado.mensaje || "No se encontró el proceso para ese radicado.";
      } else {
        const proceso = resultado.procesos[0];
        const idProceso = proceso.idProceso;

        // Traemos las últimas 7 actuaciones
        const actuaciones = await obtenerActuaciones(idProceso, 7);

        if (!actuaciones || actuaciones.length === 0) {
          sesiones[telefono] = { paso: "inicio" };
          respuesta = "✅ Proceso encontrado pero sin actuaciones registradas.\n\nDespacho: " + (proceso.despacho || "N/A");
        } else {
          // Guardamos en sesión: radicado, idProceso, lista de actuaciones
          sesiones[telefono] = {
            paso: "esperando_seleccion_actuacion",
            radicado,
            idProceso,
            actuaciones,
          };

          let msg = `📋 *Últimas actuaciones — Radicado ${radicado}*\n`;
          msg += `Despacho: ${proceso.despacho || "N/A"}\n\n`;
          for (let i = 0; i < actuaciones.length; i++) {
            const a = actuaciones[i];
            msg += `*${i + 1}.* ${a.actuacion}\n`;
            msg += `   📅 ${a.fechaActuacion || "Sin fecha"}\n`;
            if (a.anotacion) msg += `   📝 ${a.anotacion.substring(0, 80)}${a.anotacion.length > 80 ? "..." : ""}\n`;
            msg += "\n";
          }
          msg += `Responda el *número* de la actuación para ver el documento en el micrositio, o *0* para salir.`;
          respuesta = msg;
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

        const link = linkMicrositio(radicado, act.idRegActuacion);

        let msg = `📄 *${act.actuacion}*\n`;
        msg += `📅 Fecha: ${act.fechaActuacion || "N/A"}\n`;
        if (act.anotacion) msg += `📝 ${act.anotacion}\n`;
        msg += `\n🔗 Consulte el documento en el micrositio:\n${link}`;
        msg += `\n\n💼 Si desea descargar este documento, comuníquese con nosotros:\n📞 +57 313 829 1633`;
        respuesta = msg;
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

app.get("/health", (req, res) =>
  res.json({ estado: "OK", servicio: "Sánchez & Cárdenas – Bot Rama Judicial", hora: new Date().toISOString() })
);

app.listen(PORT, () => console.log(`✅ Servidor activo en http://localhost:${PORT}`));

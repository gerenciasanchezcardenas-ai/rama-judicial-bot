/**
 * ============================================================
 * SÁNCHEZ & CÁRDENAS CONSULTING S.A.S.
 * Módulo de consulta automática - Rama Judicial Colombia
 * ============================================================
 *
 * Consulta el portal oficial:
 * https://consultaprocesos.ramajudicial.gov.co
 *
 * Modos de búsqueda:
 *   1. Por nombre o razón social
 *   2. Por número de radicado
 * ============================================================
 */

const axios = require("axios");

// ── Configuración base ────────────────────────────────────────
const BASE_URL =
  "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";

const HEADERS = {
  "Content-Type": "application/json",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://consultaprocesos.ramajudicial.gov.co/Procesos/Index",
  "Origin": "https://consultaprocesos.ramajudicial.gov.co",
  "Connection": "keep-alive",
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://consultaprocesos.ramajudicial.gov.co/",
  Origin: "https://consultaprocesos.ramajudicial.gov.co",
};

// ── Función principal: buscar por nombre ─────────────────────
async function consultarPorNombre(nombre, tipoPersona = "nat") {
  try {
    const url = `${BASE_URL}/Procesos/Consulta/NombreRazonSocial`;

    const params = {
  nombre: nombre.trim().toUpperCase(),
  tipoPersona: tipoPersona,
  SoloActivos: false,
  codificacionDespacho: "",
  pagina: 1,
};

    const response = await axios.get(url, {
      params,
      headers: HEADERS,
        timeout: 15000,
      });

      return procesarRespuesta(response.data, "nombre", nombre);
    } catch (error) {
    return manejarError(error);
  }
}

// ── Función principal: buscar por radicado ───────────────────
async function consultarPorRadicado(radicado) {
  try {
    const url = `${BASE_URL}/Proceso/Consulta/NumeroRadicacion`;

    const params = {
      numero: radicado.trim().replace(/\s/g, ""),
      SoloActivos: false,
      pagina: 1,
    };

    const response = await axios.get(url, {
      params,
      headers: HEADERS,
      timeout: 15000,
    });

    return procesarRespuesta(response.data, "radicado", radicado);
  } catch (error) {
    return manejarError(error);
  }
}

// ── Procesar y estructurar la respuesta ──────────────────────
function procesarRespuesta(data, tipoBusqueda, termino) {
  // La API devuelve: { procesos: [...], cantidadRegistros: N }
  const procesos = data?.procesos || data?.Procesos || [];
  const total =
    data?.cantidadRegistros ||
    data?.CantidadRegistros ||
    procesos.length;

  if (!procesos || procesos.length === 0) {
    return {
      exito: true,
      encontrado: false,
      total: 0,
      termino,
      tipoBusqueda,
      mensaje: formatearMensajeVacio(termino),
      procesos: [],
    };
  }

  const procesosFormateados = procesos.slice(0, 5).map((p) => ({
    radicado: p.llaveProceso || p.idProceso || "N/D",
    despacho: p.despacho || "N/D",
    ponente: p.ponente || "N/D",
    tipoProceso: p.tipoProceso || "N/D",
    fechaUltimaActuacion: p.fechaUltimaActuacion || "N/D",
    sujetosProcesales: p.sujetosProcesales || "N/D",
  }));

  return {
    exito: true,
    encontrado: true,
    total,
    termino,
    tipoBusqueda,
    mensaje: formatearMensajeResultados(termino, total, procesosFormateados),
    procesos: procesosFormateados,
    hayMas: total > 5,
  };
}

// ── Formatear mensaje para WhatsApp (sin procesos) ───────────
function formatearMensajeVacio(termino) {
  return (
    `✅ *Consulta Rama Judicial*\n\n` +
    `No encontramos procesos judiciales activos registrados a nombre de:\n` +
    `*${termino}*\n\n` +
    `Si considera que esta información no es correcta o desea una revisión más detallada, nuestros abogados pueden orientarle.\n\n` +
    `_Sánchez & Cárdenas Consulting S.A.S._\n` +
    `📞 +57 313 829 1633\n` +
    `🌐 sanchezcardenasconsulting.com`
  );
}

// ── Formatear mensaje para WhatsApp (con procesos) ───────────
function formatearMensajeResultados(termino, total, procesos) {
  let msg =
    `⚠️ *Consulta Rama Judicial*\n\n` +
    `Encontramos *${total} proceso(s)* registrado(s) para:\n` +
    `*${termino}*\n\n`;

  procesos.forEach((p, i) => {
    msg += `📋 *Proceso ${i + 1}*\n`;
    msg += `• Radicado: ${p.radicado}\n`;
    msg += `• Despacho: ${p.despacho}\n`;
    msg += `• Tipo: ${p.tipoProceso}\n`;
    msg += `• Última actuación: ${p.fechaUltimaActuacion}\n\n`;
  });

  if (total > 5) {
    msg += `_...y ${total - 5} proceso(s) más._\n\n`;
  }

  msg +=
    `Le recomendamos revisar esto con un abogado a la brevedad.\n\n` +
    `¿Desea que uno de nuestros especialistas lo contacte?\n` +
    `Responda *SÍ* para agendar una consulta.\n\n` +
    `_Sánchez & Cárdenas Consulting S.A.S._\n` +
    `📞 +57 313 829 1633\n` +
    `🌐 sanchezcardenasconsulting.com`;

  return msg;
}

// ── Manejo de errores ─────────────────────────────────────────
function manejarError(error) {
  const esTimeout =
    error.code === "ECONNABORTED" || error.message.includes("timeout");
  const esConexion =
    error.code === "ENOTFOUND" || error.code === "ECONNREFUSED";

  let mensajeUsuario =
    `⚠️ En este momento el sistema de la Rama Judicial presenta dificultades técnicas.\n\n` +
    `Por favor intente nuevamente en unos minutos o contáctenos directamente:\n\n` +
    `📞 +57 313 829 1633\n` +
    `🌐 sanchezcardenasconsulting.com`;

  return {
    exito: false,
    encontrado: false,
    error: esTimeout
      ? "TIMEOUT"
      : esConexion
      ? "CONEXION"
      : "DESCONOCIDO",
    detalle: error.message,
    mensaje: mensajeUsuario,
    procesos: [],
  };
}

// ── Exportar funciones ────────────────────────────────────────
module.exports = {
  consultarPorNombre,
  consultarPorRadicado,
};

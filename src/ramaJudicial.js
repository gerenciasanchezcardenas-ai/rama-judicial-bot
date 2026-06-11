const axios = require("axios");

const BASE_URL = "https://consultaprocesos.ramajudicial.gov.co/api/v2";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://consultaprocesos.ramajudicial.gov.co/",
  Origin: "https://consultaprocesos.ramajudicial.gov.co",
};

async function consultarPorNombre(nombre) {
  try {
    const url = `${BASE_URL}/Procesos/Consulta/NombreRazonSocial`;
    const params = { nombre: nombre.trim().toUpperCase(), SoloActivos: false, pagina: 1 };
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 15000 });
    return procesarRespuesta(response.data, "nombre", nombre);
  } catch (error) {
    return manejarError(error);
  }
}

async function consultarPorRadicado(radicado) {
  try {
    const url = `${BASE_URL}/Proceso/Consulta/NumeroRadicacion`;
    const params = { numero: radicado.trim().replace(/\s/g, ""), SoloActivos: false, pagina: 1 };
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 15000 });
    return procesarRespuesta(response.data, "radicado", radicado);
  } catch (error) {
    return manejarError(error);
  }
}

function procesarRespuesta(data, tipoBusqueda, termino) {
  const procesos = data?.procesos || data?.Procesos || [];
  const total = data?.cantidadRegistros || data?.CantidadRegistros || procesos.length;
  if (!procesos || procesos.length === 0) {
    return { exito: true, encontrado: false, total: 0, termino, tipoBusqueda, mensaje: formatearMensajeVacio(termino), procesos: [] };
  }
  const procesosFormateados = procesos.slice(0, 5).map((p) => ({
    radicado: p.llaveProceso || p.idProceso || "N/D",
    despacho: p.despacho || "N/D",
    tipoProceso: p.tipoProceso || "N/D",
    fechaUltimaActuacion: p.fechaUltimaActuacion || "N/D",
  }));
  return { exito: true, encontrado: true, total, termino, tipoBusqueda, mensaje: formatearMensajeResultados(termino, total, procesosFormateados), procesos: procesosFormateados };
}

function formatearMensajeVacio(termino) {
  return `✅ *Consulta Rama Judicial*\n\nNo encontramos procesos judiciales activos para:\n*${termino}*\n\n¿Desea hablar con uno de nuestros abogados?\n\n_Sánchez & Cárdenas Consulting S.A.S._\n📞 +57 313 829 1633\n🌐 sanchezcardenasconsulting.com`;
}

function formatearMensajeResultados(termino, total, procesos) {
  let msg = `⚠️ *Consulta Rama Judicial*\n\nEncontramos *${total} proceso(s)* para:\n*${termino}*\n\n`;
  procesos.forEach((p, i) => {
    msg += `📋 *Proceso ${i + 1}*\n• Radicado: ${p.radicado}\n• Despacho: ${p.despacho}\n• Tipo: ${p.tipoProceso}\n• Última actuación: ${p.fechaUltimaActuacion}\n\n`;
  });
  msg += `Le recomendamos asesoría jurídica urgente.\n¿Desea que un abogado lo contacte? Responda *SÍ*.\n\n_Sánchez & Cárdenas Consulting S.A.S._\n📞 +57 313 829 1633`;
  return msg;
}

function manejarError(error) {
  return { exito: false, encontrado: false, error: error.message, mensaje: `⚠️ El sistema de Rama Judicial presenta dificultades técnicas.\n\nPor favor intente nuevamente o contáctenos:\n📞 +57 313 829 1633\n🌐 sanchezcardenasconsulting.com`, procesos: [] };
}

module.exports = { consultarPorNombre, consultarPorRadicado };

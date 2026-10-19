// Procesos judiciales — Consulta Nacional Unificada de la Rama Judicial.
// La entidad pide pausas entre llamadas; se respetan 1,5 s entre cada una.
const axios = require("axios");

const BASE_URL = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Referer: "https://consultaprocesos.ramajudicial.gov.co/",
  Origin: "https://consultaprocesos.ramajudicial.gov.co",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};
const PAUSA_MS = 1500;
const MAX_PAGINAS = 3;
const MAX_ACTUACIONES = 8;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// La API devuelve los sujetos como texto ("Demandante: X | Demandado: Y") o como lista.
function partes(sujetos) {
  const demandantes = [];
  const demandados = [];
  const agregar = (tipo, nombre) => {
    tipo = (tipo || "").trim().toUpperCase();
    nombre = (nombre || "").trim();
    if (!nombre) return;
    if (tipo.startsWith("DEMANDANTE")) demandantes.push(nombre);
    else if (tipo.startsWith("DEMANDADO")) demandados.push(nombre);
  };
  if (Array.isArray(sujetos)) {
    sujetos.forEach((s) => agregar(s.tipoSujeto, s.nombre || s.razonSocial));
  } else if (typeof sujetos === "string") {
    sujetos.split("|").forEach((t) => {
      const i = t.indexOf(":");
      if (i > -1) agregar(t.slice(0, i), t.slice(i + 1));
    });
  }
  return { demandantes, demandados };
}

function normalizar(p) {
  const { demandantes, demandados } = partes(p.sujetosProcesales);
  return {
    idProceso: p.idProceso,
    radicado: p.llaveProceso || "",
    despacho: (p.despacho || "").trim(),
    departamento: (p.departamento || "").trim(),
    fechaRadicacion: (p.fechaProceso || "").slice(0, 10),
    fechaUltimaActuacion: (p.fechaUltimaActuacion || "").slice(0, 10),
    demandantes,
    demandados,
    ultimaActuacion: null,
  };
}

// Consulta por nombre o razón social. tipoPersona: "nat" o "jur".
async function consultarPorNombre(nombre, tipoPersona) {
  const procesos = [];
  let total = 0;
  try {
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      if (pagina > 1) await esperar(PAUSA_MS);
      const { data } = await axios.get(`${BASE_URL}/Procesos/Consulta/NombreRazonSocial`, {
        headers: HEADERS,
        timeout: 30000,
        params: { nombre: nombre.trim().toUpperCase(), tipoPersona, SoloActivos: false, codificacionDespacho: "", pagina },
      });
      if (data && data.StatusCode === 400) return { ok: true, demasiados: true, total: 1000, procesos: [] };
      total = (data && data.paginacion && data.paginacion.cantidadRegistros) || 0;
      (data && data.procesos ? data.procesos : []).forEach((p) => procesos.push(normalizar(p)));
      const paginas = (data && data.paginacion && data.paginacion.cantidadPaginas) || 1;
      if (pagina >= paginas) break;
    }
    return { ok: true, demasiados: false, total, procesos };
  } catch (e) {
    // La API responde 400 cuando hay más de 1.000 coincidencias.
    if (e.response && e.response.status === 400) return { ok: true, demasiados: true, total: 1000, procesos: [] };
    console.error("Error Rama Judicial:", e.message);
    return { ok: false, demasiados: false, total: 0, procesos };
  }
}

async function ultimaActuacion(idProceso) {
  try {
    const { data } = await axios.get(`${BASE_URL}/Proceso/Actuaciones/${idProceso}`, {
      headers: HEADERS, timeout: 20000, params: { pagina: 1 },
    });
    const u = data && data.actuaciones && data.actuaciones[0];
    if (!u) return null;
    const fin = (u.fechaFinTermino || "").slice(0, 10);
    return {
      actuacion: u.actuacion || "",
      anotacion: (u.anotacion || "").slice(0, 500),
      fecha: (u.fechaActuacion || "").slice(0, 10),
      venceTermino: fin && fin !== "0001-01-01" ? fin : "",
    };
  } catch (e) {
    console.error("Error actuaciones " + idProceso + ":", e.message);
    return null;
  }
}

// Completa la última actuación de los procesos más recientes, uno por uno, con pausa.
async function completarActuaciones(procesos) {
  const ordenados = [...procesos].sort((a, b) => (b.fechaUltimaActuacion || "").localeCompare(a.fechaUltimaActuacion || ""));
  for (const p of ordenados.slice(0, MAX_ACTUACIONES)) {
    if (!p.idProceso) continue;
    await esperar(PAUSA_MS);
    p.ultimaActuacion = await ultimaActuacion(p.idProceso);
  }
  return procesos;
}

function resumenRama(procesos) {
  const haceUnAnio = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recientes = procesos.filter((p) => p.fechaUltimaActuacion && p.fechaUltimaActuacion >= haceUnAnio).length;
  return { total: procesos.length, recientes };
}

module.exports = { consultarPorNombre, completarActuaciones, resumenRama, partes };

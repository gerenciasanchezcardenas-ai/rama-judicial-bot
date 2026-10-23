const axios = require("axios");
const BASE_URL = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
const HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "Referer": "https://consultaprocesos.ramajudicial.gov.co/",
  "Origin": "https://consultaprocesos.ramajudicial.gov.co",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

async function consultarPorNombre(nombre, tipoPersona = "auto") {
  if (tipoPersona === "auto") {
    tipoPersona = inferirTipoPersona(nombre);
  }
  try {
    const url = `${BASE_URL}/Procesos/Consulta/NombreRazonSocial`;
    const params = {
      nombre: nombre.trim().toUpperCase(),
      tipoPersona: tipoPersona,
      SoloActivos: false,
      codificacionDespacho: "",
      pagina: 1,
    };
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 30000 });
    console.log("tipoPersona usado:", tipoPersona);
    console.log("DATA:", JSON.stringify(response.data).substring(0, 300));
    return procesarRespuesta(response.data, nombre);
  } catch (error) {
    console.error("Error consultarPorNombre:", error.message,
      error.response && error.response.status,
      error.response && JSON.stringify(error.response.data).substring(0, 200));
    return manejarError(error);
  }
}

function inferirTipoPersona(nombre) {
  const siglasJuridicas = /\b(S\.A\.S|SAS|S\.A|LTDA|LIMITADA|E\.U|S\.C\.A|INC|CORP|DRILLING|ENERGY|OIL|SERVICES|COMPANY|CIA|ASOCIADOS|INGENIERIA|CONSTRUCTORA|CONSTRUCCIONES)\b/i;
  return siglasJuridicas.test(nombre) ? "jur" : "nat";
}

async function consultarPorRadicado(radicado) {
  try {
    const url = `${BASE_URL}/Procesos/Consulta/NumeroRadicacion`;
    const params = {
      numero: radicado.trim().replace(/\s/g, ""),
      SoloActivos: false,
      pagina: 1,
    };
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 30000 });
    return procesarRespuesta(response.data, radicado);
  } catch (error) {
    console.error("Error consultarPorRadicado:", error.message);
    return manejarError(error);
  }
}

// Trae únicamente la última actuación (compatibilidad con sync-rama-judicial)
async function obtenerUltimaActuacion(idProceso) {
  const lista = await obtenerActuaciones(idProceso, 1);
  return lista && lista.length > 0 ? lista[0] : null;
}

// Trae las últimas N actuaciones de un proceso dado su idProceso numérico.
// Retorna array de { actuacion, anotacion, fechaActuacion, fechaFinTermino, idRegActuacion }
async function obtenerActuaciones(idProceso, cantidad = 7) {
  const intentos = 3;
  for (let i = 1; i <= intentos; i++) {
    try {
      const url = `${BASE_URL}/Proceso/Actuaciones/${idProceso}`;
      const params = { pagina: 1 };
      const response = await axios.get(url, { params, headers: HEADERS, timeout: 45000 });
      const data = response.data;
      if (data && data.actuaciones && data.actuaciones.length > 0) {
        console.log(`obtenerActuaciones OK en intento ${i}, idProceso=${idProceso}`);
        return data.actuaciones.slice(0, cantidad).map(a => ({
          actuacion: a.actuacion || "",
          anotacion: a.anotacion || "",
          fechaActuacion: (a.fechaActuacion || "").substring(0, 10),
          fechaFinTermino: (a.fechaFinTermino || "").substring(0, 10),
          fechaRegistro: (a.fechaRegistro || "").substring(0, 10),
          idRegActuacion: a.idRegActuacion || null,
        }));
      }
      console.log(`obtenerActuaciones devolvió vacío (intento ${i}/${intentos}), idProceso=${idProceso}`);
      if (i < intentos) await new Promise(r => setTimeout(r, 2000));
    } catch (error) {
      console.error(`Error obtenerActuaciones intento ${i}/${intentos} idProceso=${idProceso}:`, error.message);
      if (i < intentos) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return [];
}

// Construye el link directo al micrositio para una actuación
function linkMicrositio(radicado, idRegActuacion) {
  // Formato del radicado para el micrositio: AAAA-NNNNN (posiciones 12-15 y 16-20)
  const r = radicado.replace(/\s/g, "");
  if (r.length >= 21) {
    const year = r.substring(12, 16);
    const num = r.substring(16, 21);
    const fragment = `${year}-${num}`;
    return `https://publicacionesprocesales.ramajudicial.gov.co/index.html#/detail/${fragment}`;
  }
  return `https://publicacionesprocesales.ramajudicial.gov.co/`;
}

function procesarRespuesta(data, termino) {
  if (data && data.StatusCode === 400) {
    return {
      tieneProcesos: true,
      cantidad: 1000,
      procesos: [],
      resumenPrevio: "Se encontraron mas de 1.000 procesos para " + termino + ". Por favor ingrese el nombre completo.",
      detalle: "Se encontraron mas de 1.000 procesos para " + termino + ". Por favor ingrese el nombre completo.",
      mensaje: "",
    };
  }
  const cantidad = (data && data.paginacion && data.paginacion.cantidadRegistros) ? data.paginacion.cantidadRegistros : 0;
  const procesos = (data && data.procesos) ? data.procesos : [];
  if (cantidad === 0 || procesos.length === 0) {
    return {
      tieneProcesos: false,
      cantidad: 0,
      procesos: [],
      resumenPrevio: "",
      detalle: "",
      mensaje: "No se encontraron procesos registrados para " + termino + " en la Rama Judicial.",
    };
  }

  const activos = procesos.filter(p => p.esPrivado === false || p.fechaUltimaActuacion).length;
  const archivados = procesos.length - activos;

  let resumenPrevio = "⚠️ Se encontraron *" + cantidad + " proceso(s)* para *" + termino + "*.\n\n";
  resumenPrevio += "📋 De los primeros " + procesos.length + " registros:\n";
  resumenPrevio += "🔴 Activos: " + activos + "\n";
  resumenPrevio += "📁 Archivados: " + archivados + "\n\n";
  resumenPrevio += "Para ver el detalle completo (radicados, despachos, tipos y fechas) realice el pago.";

  let detalle = "✅ Reporte de procesos para *" + termino + "* (" + cantidad + " proceso(s) total):\n\n";
  const lista = procesos.slice(0, 5);
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    detalle += (i + 1) + ". Radicado: " + (p.llaveProceso || "N/A") + "\n";
    detalle += "   Despacho: " + (p.despacho || "N/A") + "\n";
    detalle += "   Tipo: " + (p.tipoProceso || "N/A") + "\n";
    detalle += "   Fecha: " + ((p.fechaProceso || "").substring(0, 10) || "N/A") + "\n\n";
  }
  if (cantidad > 5) {
    detalle += "...y " + (cantidad - 5) + " proceso(s) mas. Consulte en: https://consultaprocesos.ramajudicial.gov.co";
  }

  return { tieneProcesos: true, cantidad, procesos, resumenPrevio, detalle, mensaje: "" };
}

function manejarError(error) {
  console.error("Status error:", error.message);
  return {
    tieneProcesos: false,
    cantidad: 0,
    procesos: [],
    resumenPrevio: "",
    detalle: "",
    mensaje: "El sistema de Rama Judicial presenta dificultades tecnicas. Por favor intente nuevamente o contactenos: +57 313 829 1633",
  };
}

module.exports = { consultarPorNombre, consultarPorRadicado, obtenerUltimaActuacion, obtenerActuaciones, linkMicrositio };

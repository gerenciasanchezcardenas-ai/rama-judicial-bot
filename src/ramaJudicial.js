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
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 15000 });
    return procesarRespuesta(response.data, radicado);
  } catch (error) {
    console.error("Error consultarPorRadicado:", error.message);
    return manejarError(error);
  }
}

function procesarRespuesta(data, termino) {
  if (data && data.StatusCode === 400) {
    return {
      tieneProcesos: true,
      cantidad: 1000,
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
      detalle: "",
      mensaje: "No se encontraron procesos registrados para " + termino + " en la Rama Judicial.",
    };
  }
  let detalle = "Resultados para " + termino + " (" + cantidad + " proceso(s)):\n\n";
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
  return { tieneProcesos: true, cantidad: cantidad, detalle: detalle, mensaje: "" };
}

function manejarError(error) {
  console.error("Status error:", error.message);
  return {
    tieneProcesos: false,
    cantidad: 0,
    detalle: "",
    mensaje: "El sistema de Rama Judicial presenta dificultades tecnicas. Por favor intente nuevamente o contactenos: +57 313 829 1633",
  };
}

module.exports = { consultarPorNombre, consultarPorRadicado };

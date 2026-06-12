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
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 15000 });
    return procesarRespuesta(response.data, "nombre", nombre);
  } catch (error) {
    console.error("Error consultarPorNombre:", error.message);
    return manejarError(error);
  }
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
    return procesarRespuesta(response.data, "radicado", radicado);
  } catch (error) {
    console.error("Error consultarPorRadicado:", error.message);
    return manejarError(error);
  }
}

function procesarRespuesta(data, tipoBusqueda, termino) {
  if (!data || !data.procesos || data.procesos.length === 0) {
    return {
      mensaje: `⚠️ No se encontraron procesos para *${termino}*.\n\nVerifique el dato ingresado o consulte directamente en:\n🔗 https://consultaprocesos.ramajudicial.gov.co`,
    };
  }

  const procesos = data.procesos.slice(0, 5);
  let mensaje = `✅ Se encontraron *${data.cantidadRegistros}* proceso(s) para *${termino}*:\n\n`;

  procesos.forEach((p, i) => {
    mensaje += `*${i + 1}.* Radicado: ${p.llaveProceso || "N/A"}\n`;
    mensaje += `📍 Despacho: ${p.despacho || "N/A"}\n`;
    mensaje += `⚖️ Tipo: ${p.tipoProceso || "N/A"}\n`;
    mensaje += `📅 Fecha: ${p.fechaProceso || "N/A"}\n\n`;
  });

  if (data.cantidadRegistros > 5) {
    mensaje += `_...y ${data.cantidadRegistros - 5} proceso(s) más. Consulte en:_\n🔗 https://consultaprocesos.ramajudicial.gov.co`;
  }

  return { mensaje };
}

function manejarError(error) {
  const status = error.response?.status;
  console.error("Status error:", status, error.message);
  return {
    mensaje: `⚠️ El sistema de Rama Judicial presenta dificultades técnicas.\n\nPor favor intente nuevamente o contáctenos:\n📞 *+57 313 829 1633*\n🌐 sanchezcardenasconsulting.com`,
  };
}

module.exports = { consultarPorNombre, consultarPorRadicado };

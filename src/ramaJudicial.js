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

// ✅ FIX: acepta "nat" | "jur" | "auto"
// Con "auto" detecta automáticamente según si el nombre
// parece persona natural (tiene apellido + nombre) o jurídica
async function consultarPorNombre(nombre, tipoPersona = "auto") {
  // Resolución automática del tipo
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
    const response = await axios.get(url, { params, headers: HEADERS, timeout: 15000 });
    console.log("tipoPersona usado:", tipoPersona);
    console.log("DATA:", JSON.stringify(response.data).substring(0, 300));
    return procesarRespuesta(response.data, nombre);
  } catch (error) {  // ✅ FIX: catch estaba faltando
    console.error(
      "Error consultarPorNombre:",
      error.message,
      error.response && error.response.status,
      error.response && JSON.stringify(error.response.data).substring(0, 200)
    );
    return manejarError(error);
  }
}

// Heurística: si el nombre contiene siglas societarias → jurídica
function inferirTipoPersona(nombre) {
  const siglasJuridicas = /\b(S\.A\.S|SAS|S\.A|LTDA|LIMITADA|E\.U|S\.C\.A|INC|CORP|DRILLING|ENERGY|OIL|SERVICES|COMPANY|CIA|ASOCIADOS|INGENIERIA|CONSTRUCTORA|CONSTRUCCIONES)\b/i;
  return siglasJuridicas.test(nombre) ? "jur" : "nat";
}

async function consultarPorRadicado(radicado) {
  try {
    const url =

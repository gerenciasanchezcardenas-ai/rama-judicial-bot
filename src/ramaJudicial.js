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
    const response = await

// Pagos con Wompi: enlace de pago firmado, verificación de eventos y consulta de transacciones.
const crypto = require("crypto");
const axios = require("axios");

const PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || "";
const INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY || "";
const EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET || "";
const PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY || "";

const esPrueba = PUBLIC_KEY.startsWith("pub_test");
const API = esPrueba ? "https://sandbox.wompi.co/v1" : "https://production.wompi.co/v1";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function enlacePago(referencia, valorCentavos, redirectUrl) {
  const firma = sha256(referencia + valorCentavos + "COP" + INTEGRITY_KEY);
  // Wompi espera el parámetro "signature:integrity" con los dos puntos sin codificar.
  let url = "https://checkout.wompi.co/p/?public-key=" + encodeURIComponent(PUBLIC_KEY) +
    "&currency=COP&amount-in-cents=" + valorCentavos +
    "&reference=" + encodeURIComponent(referencia) +
    "&signature:integrity=" + firma;
  if (redirectUrl) url += "&redirect-url=" + encodeURIComponent(redirectUrl);
  return url;
}

// Wompi firma cada evento: sha256(valores de signature.properties + timestamp + secreto de eventos).
function eventoValido(evento) {
  if (!EVENTS_SECRET) {
    console.warn("WOMPI_EVENTS_SECRET no configurado: el evento no se puede verificar y se descarta.");
    return false;
  }
  try {
    const props = (evento.signature && evento.signature.properties) || [];
    const valores = props.map((ruta) => ruta.split(".").reduce((o, k) => (o == null ? o : o[k]), evento.data)).join("");
    const calculado = sha256(valores + evento.timestamp + EVENTS_SECRET);
    return calculado.toLowerCase() === String(evento.signature.checksum || "").toLowerCase();
  } catch (e) {
    return false;
  }
}

// Respaldo: pregunta directamente a Wompi por la transacción de una referencia.
async function transaccionAprobada(referencia) {
  if (!PRIVATE_KEY) return null;
  try {
    const { data } = await axios.get(API + "/transactions", {
      params: { reference: referencia },
      headers: { Authorization: "Bearer " + PRIVATE_KEY },
      timeout: 15000,
    });
    return (data.data || []).find((t) => t.status === "APPROVED") || null;
  } catch (e) {
    console.error("Error consultando Wompi:", e.message);
    return null;
  }
}

module.exports = { enlacePago, eventoValido, transaccionAprobada, sha256 };

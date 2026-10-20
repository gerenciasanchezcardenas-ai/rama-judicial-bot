// Acceso a Supabase por su API REST, con la llave service_role (solo en el servidor).
const axios = require("axios");

// Acepta la dirección con o sin "/rest/v1/" al final.
const URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/rest/v1";
const KEY = process.env.SUPABASE_SERVICE_KEY || "";

const api = axios.create({
  baseURL: URL,
  timeout: 15000,
  // Sirve con la llave "service_role" (JWT, empieza por eyJ) o con la nueva llave secreta (sb_secret_...).
  // La nueva solo va en el encabezado apikey; enviarla como Bearer la hace rechazar.
  headers: Object.assign(
    { apikey: KEY, "Content-Type": "application/json" },
    KEY.startsWith("eyJ") ? { Authorization: "Bearer " + KEY } : {}
  ),
});

// ── Sesiones ────────────────────────────────────────────────
async function leerSesion(telefono) {
  const { data } = await api.get("/pjp_sesiones", { params: { telefono: "eq." + telefono, select: "*" } });
  return data[0] || { telefono, paso: "inicio", datos: {} };
}

async function guardarSesion(telefono, paso, datos = {}) {
  await api.post("/pjp_sesiones", { telefono, paso, datos, updated_at: new Date().toISOString() }, {
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

// ── Solicitudes ─────────────────────────────────────────────
async function crearSolicitud(fila) {
  const { data } = await api.post("/pjp_solicitudes", fila, { headers: { Prefer: "return=representation" } });
  return data[0];
}

async function solicitudPorReferencia(referencia) {
  const { data } = await api.get("/pjp_solicitudes", { params: { referencia: "eq." + referencia, select: "*" } });
  return data[0] || null;
}

async function solicitudPorToken(token) {
  const { data } = await api.get("/pjp_solicitudes", { params: { token_reporte: "eq." + token, select: "*" } });
  return data[0] || null;
}

// Actualiza solo si el estado actual coincide (evita entregar dos veces el mismo reporte).
async function actualizarSolicitud(referencia, cambios, estadoEsperado) {
  const params = { referencia: "eq." + referencia };
  if (estadoEsperado) params.estado = "eq." + estadoEsperado;
  const { data } = await api.patch("/pjp_solicitudes", cambios, { params, headers: { Prefer: "return=representation" } });
  return data[0] || null;
}

async function solicitudesPendientesDePago(desdeHoras = 24) {
  const desde = new Date(Date.now() - desdeHoras * 3600 * 1000).toISOString();
  const { data } = await api.get("/pjp_solicitudes", {
    params: { estado: "eq.pendiente_pago", created_at: "gte." + desde, select: "referencia" },
  });
  return data;
}

module.exports = {
  leerSesion, guardarSesion, crearSolicitud, solicitudPorReferencia,
  solicitudPorToken, actualizarSolicitud, solicitudesPendientesDePago,
};

// ── Herramienta interna ─────────────────────────────────────
async function solicitudesParaSNR() {
  const { data } = await api.get("/pjp_solicitudes", {
    params: {
      estado: "in.(pagado,reporte_enviado)",
      select: "referencia,nombre,tipo_persona,tipo_documento,documento,telefono,pagado_at,snr_vence_at,estado",
      order: "snr_vence_at.asc",
    },
  });
  return data;
}

async function complementosRecientes(limite = 15) {
  const { data } = await api.get("/pjp_solicitudes", {
    params: {
      estado: "eq.complemento_enviado",
      select: "referencia,nombre,tipo_documento,documento,complemento_at,snr_vence_at,snr_cargado_por",
      order: "complemento_at.desc",
      limit: limite,
    },
  });
  return data;
}

module.exports.solicitudesParaSNR = solicitudesParaSNR;
module.exports.complementosRecientes = complementosRecientes;

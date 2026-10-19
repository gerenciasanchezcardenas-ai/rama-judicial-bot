// Contratos con entidades públicas — SECOP II, datos abiertos (datos.gov.co, conjunto jbjy-vk9h).
// No requiere llave. SECOP_APP_TOKEN es opcional y solo amplía el límite de consultas.
const axios = require("axios");

const URL = "https://www.datos.gov.co/resource/jbjy-vk9h.json";

function numero(v) {
  const n = Number(String(v || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function ultimos4(cuenta) {
  const d = String(cuenta || "").replace(/\D/g, "");
  return d.length >= 4 ? "terminada en " + d.slice(-4) : "";
}

async function consultarContratos(documento) {
  const doc = String(documento || "").replace(/\D/g, "");
  if (!doc) return { ok: true, contratos: [] };
  try {
    const headers = {};
    if (process.env.SECOP_APP_TOKEN) headers["X-App-Token"] = process.env.SECOP_APP_TOKEN;
    const { data } = await axios.get(URL, {
      headers,
      timeout: 20000,
      params: {
        $where: `documento_proveedor='${doc}'`,
        $order: "fecha_de_firma DESC",
        $limit: 50,
      },
    });
    const contratos = (data || []).map((c) => ({
      entidad: c.nombre_entidad || "",
      nitEntidad: c.nit_entidad || "",
      ciudad: [c.ciudad, c.departamento].filter(Boolean).join(", "),
      idContrato: c.id_contrato || "",
      estado: c.estado_contrato || "",
      tipo: c.tipo_de_contrato || "",
      objeto: (c.objeto_del_contrato || c.descripcion_del_proceso || "").slice(0, 400),
      fechaFirma: (c.fecha_de_firma || "").slice(0, 10),
      fechaFin: (c.fecha_de_fin_del_contrato || "").slice(0, 10),
      valor: numero(c.valor_del_contrato),
      valorPagado: numero(c.valor_pagado),
      valorPendientePago: numero(c.valor_pendiente_de_pago),
      banco: c.nombre_del_banco && !/no definido/i.test(c.nombre_del_banco) ? c.nombre_del_banco : "",
      tipoCuenta: c.tipo_de_cuenta && !/no definido/i.test(c.tipo_de_cuenta) ? c.tipo_de_cuenta : "",
      cuenta: ultimos4(c.n_mero_de_cuenta),
      url: (c.urlproceso && c.urlproceso.url) || "",
    }));
    return { ok: true, contratos };
  } catch (e) {
    console.error("Error SECOP:", e.message);
    return { ok: false, contratos: [] };
  }
}

function resumenSecop(contratos) {
  const enEjecucion = contratos.filter((c) => /ejecuci|activo|modificado/i.test(c.estado)).length;
  const pendiente = contratos.reduce((s, c) => s + c.valorPendientePago, 0);
  return { total: contratos.length, enEjecucion, pendiente };
}

module.exports = { consultarContratos, resumenSecop };

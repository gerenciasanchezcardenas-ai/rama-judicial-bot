// ============================================================
// sync-rama-judicial.js
// Portal de Monitoreo Judicial — Sánchez & Cárdenas Consulting
// Sincronización automática con la Rama Judicial de Colombia
// Fuente 1: API consultaprocesos.ramajudicial.gov.co
// Fuente 2: Micrositio publicacionesprocesales.ramajudicial.gov.co
// Corre diario L-V a las 6:00 a.m. vía Render cron
// ============================================================

require("dotenv").config();
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

// ── SUPABASE ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── API RAMA JUDICIAL ─────────────────────────────────────────
const BASE_URL = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
const HEADERS_RAMA = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "Referer": "https://consultaprocesos.ramajudicial.gov.co/",
  "Origin": "https://consultaprocesos.ramajudicial.gov.co",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

// ── MICROSITIO PUBLICACIONES PROCESALES ───────────────────────
// Portal Liferay de la Rama Judicial con publicaciones por despacho
const MICROSITIO_BASE = "https://publicacionesprocesales.ramajudicial.gov.co";
const PORTLET_ID = "co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq";
const PORTLET_PREFIX = `_${PORTLET_ID}_`;

// Parámetro fijo del portlet (idDeptoIdCategory del depto de Bogotá)
// Para otros departamentos este valor puede variar; se puede omitir
// si no es estrictamente necesario para la búsqueda.
// Lo dejamos vacío por defecto y solo lo usamos para Bogotá.
const ID_DEPTO_CATEGORY = {
  "11": "178847780", // Bogotá
};

const HEADERS_MICROSITIO = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-CO,es;q=0.9",
};

// ── PAUSA entre llamadas ──────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// FUENTE 1 — API RAMA JUDICIAL
// ============================================================

// 1a. Obtener idProceso desde el número de radicado
async function obtenerIdProceso(numeroRadicado) {
  try {
    const url = `${BASE_URL}/Procesos/Consulta/NumeroRadicacion`;
    const params = {
      numero: numeroRadicado.trim().replace(/\s/g, ""),
      SoloActivos: false,
      pagina: 1,
    };
    const response = await axios.get(url, { params, headers: HEADERS_RAMA, timeout: 30000 });
    const procesos = response.data?.procesos || [];
    if (procesos.length === 0) return null;
    const match = procesos.find(
      (p) => (p.llaveProceso || "").replace(/\s/g, "") === numeroRadicado.replace(/\s/g, "")
    ) || procesos[0];
    return match.idProceso || null;
  } catch (err) {
    console.error(`[obtenerIdProceso] ${numeroRadicado}:`, err.message);
    return null;
  }
}

// 1b. Obtener última actuación dado idProceso
async function obtenerUltimaActuacion(idProceso) {
  try {
    const url = `${BASE_URL}/Proceso/Actuaciones/${idProceso}`;
    const response = await axios.get(url, { params: { pagina: 1 }, headers: HEADERS_RAMA, timeout: 20000 });
    const actuaciones = response.data?.actuaciones || [];
    if (actuaciones.length === 0) return null;
    const ult = actuaciones[0];
    return {
      actuacion: ult.actuacion || "",
      anotacion: (ult.anotacion || "").trim(),
      fechaActuacion: (ult.fechaActuacion || "").substring(0, 10),
      fechaFinTermino: (ult.fechaFinTermino || "").substring(0, 10),
      fechaRegistro: (ult.fechaRegistro || "").substring(0, 10),
    };
  } catch (err) {
    console.error(`[obtenerUltimaActuacion] idProceso=${idProceso}:`, err.message);
    return null;
  }
}

// ============================================================
// FUENTE 2 — MICROSITIO PUBLICACIONES PROCESALES
// ============================================================

// 2a. Extraer código de despacho y fragmento de radicado a partir
//     del número de radicado de 23 dígitos.
//
//     Estructura del radicado: DDDEEESSSPPPAAAAANNNNNNN II
//     DDD  = 2-3 dígitos depto  (pos 0-1)
//     EEE  = 3 dígitos municipio (pos 2-4)  [solo 3 en código DANE]
//     SS   = 2 dígitos especialidad (pos 5-6)  [40 = civil, 05 = laboral...]
//     PPP  = 3 dígitos clase proceso (pos 7-9)  [028 = municipal...]
//       → código despacho = primeros 12 dígitos
//     AAAA = año (pos 12-15)
//     NNNNN= número proceso (pos 16-20)  ← SIN los 2 últimos
//       → fragmento búsqueda = AAAA-NNNNN (ej: "2023-00682")
//
function parsearRadicado(numero) {
  const n = numero.trim().replace(/\s/g, "");
  if (n.length !== 23) return null;

  const codigoDespacho = n.substring(0, 12);   // ej: "110014003028"
  const anio           = n.substring(12, 16);   // ej: "2023"
  const numProceso     = n.substring(16, 21);   // ej: "00682"  (5 dígitos)
  const codigoDpto     = n.substring(0, 2);     // ej: "11"

  return {
    codigoDespacho,
    fragmentoBusqueda: `${anio}-${numProceso}`,  // ej: "2023-00682"
    codigoDpto,
    codigoMunicipio: n.substring(0, 5),          // ej: "11001"
    especialidad: n.substring(5, 7),             // ej: "40" → civil
    anio,
    numProceso,
  };
}

// 2b. Mapear código de especialidad del radicado al valor usado
//     por el micrositio (puede diferir del código DANE interno)
function especialidadMicrositio(codEspecialidad) {
  const mapa = {
    "40": "03", // Civil municipal / circuito → CIVIL
    "03": "03",
    "05": "05", // Laboral
    "10": "10", // Familia
    "04": "04", // Penal
    "01": "01", // Administrativa
  };
  return mapa[codEspecialidad] || "03";
}

// 2c. Construir la URL de búsqueda del micrositio para un despacho
function urlBusquedaDespacho(parsed) {
  const idDeptoCategory = ID_DEPTO_CATEGORY[parsed.codigoDpto] || "";
  const espMicro = especialidadMicrositio(parsed.especialidad);

  const params = new URLSearchParams({
    p_p_id: PORTLET_ID,
    p_p_lifecycle: "0",
    p_p_state: "normal",
    p_p_mode: "view",
    [`${PORTLET_PREFIX}action`]: "busqueda",
    [`${PORTLET_PREFIX}idDepto`]: parsed.codigoDpto,
    [`${PORTLET_PREFIX}idMuni`]: parsed.codigoMunicipio,
    [`${PORTLET_PREFIX}idEspecialidad`]: espMicro,
    [`${PORTLET_PREFIX}idDespacho`]: parsed.codigoDespacho,
    [`${PORTLET_PREFIX}verTotales`]: "true",
  });

  if (idDeptoCategory) {
    params.set(`${PORTLET_PREFIX}idDeptoIdCategory`, idDeptoCategory);
  }

  return `${MICROSITIO_BASE}/web/publicaciones-procesales/inicio?${params.toString()}`;
}

// 2d. Llamar al micrositio y extraer la lista de publicaciones recientes.
//     Devuelve array de { titulo, fechaPublicacion, articleId }
async function obtenerPublicacionesDespacho(parsed) {
  const url = urlBusquedaDespacho(parsed);
  try {
    const resp = await axios.get(url, {
      headers: HEADERS_MICROSITIO,
      timeout: 30000,
      maxRedirects: 5,
    });
    const html = resp.data || "";

    // Extraer publicaciones del HTML
    // Cada publicación tiene un botón "VER DETALLE" con articleId en su href
    const publicaciones = [];

    // Patrón: articleId=XXXXXXX aparece en los links de detalle
    const regexArticle = new RegExp(
      `${PORTLET_PREFIX}articleId=(\\d+)[^"]*${PORTLET_PREFIX}nomDespacho`,
      "g"
    );

    // Extraer articleId y título de cada card
    // El HTML tiene: <h2 ...>TÍTULO</h2> ... articleId=XXX
    const regexCard = /<h2[^>]*class="[^"]*titulo[^"]*"[^>]*>([\s\S]*?)<\/h2>[\s\S]*?articleId=(\d+)/gi;
    let m;
    while ((m = regexCard.exec(html)) !== null) {
      const titulo = m[1].replace(/<[^>]+>/g, "").trim();
      const articleId = m[2];
      publicaciones.push({ titulo, articleId });
    }

    // Si el regex anterior no capturó nada, intentar patrón alternativo
    if (publicaciones.length === 0) {
      const regexAlt = /articleId=(\d+)/g;
      const fechaRegex = /Fecha de [Pp]ublicaci[oó]n.*?(\d{4}-\d{2}-\d{2})/g;
      const idsSet = new Set();
      let ma;
      while ((ma = regexAlt.exec(html)) !== null) {
        const aid = ma[1];
        if (!idsSet.has(aid)) {
          idsSet.add(aid);
          publicaciones.push({ titulo: "", articleId: aid });
        }
      }
    }

    console.log(`      [micrositio] Publicaciones encontradas en despacho: ${publicaciones.length}`);
    return publicaciones.slice(0, 20); // máximo 20 publicaciones recientes
  } catch (err) {
    console.error(`[obtenerPublicacionesDespacho]:`, err.message);
    return [];
  }
}

// 2e. Obtener el detalle de una publicación y buscar documentos
//     que contengan el fragmento del radicado en su nombre
async function buscarDocumentosEnPublicacion(articleId, fragmento, parsed) {
  const params = new URLSearchParams({
    p_p_id: PORTLET_ID,
    p_p_lifecycle: "0",
    p_p_state: "normal",
    p_p_mode: "view",
    [`${PORTLET_PREFIX}jspPage`]: "/META-INF/resources/detail.jsp",
    [`${PORTLET_PREFIX}articleId`]: articleId,
    [`${PORTLET_PREFIX}nomDepto`]: "BOGOTÁ",
    [`${PORTLET_PREFIX}nomMuni`]: "BOGOTÁ D.C.",
    [`${PORTLET_PREFIX}nomEspecialidad`]: "CIVIL",
    [`${PORTLET_PREFIX}nomDespacho`]: "JUZGADO 028 CIVIL MUNICIPAL DE BOGOTÁ",
    [`${PORTLET_PREFIX}nomEntidad`]: "JUZGADO MUNICIPAL",
  });

  const url = `${MICROSITIO_BASE}/web/publicaciones-procesales/inicio?${params.toString()}`;

  try {
    const resp = await axios.get(url, {
      headers: HEADERS_MICROSITIO,
      timeout: 25000,
      maxRedirects: 5,
    });
    const html = resp.data || "";

    // Buscar el título de la publicación (Estado No., Traslado, Auto, etc.)
    const tituloMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const tituloPub = tituloMatch
      ? tituloMatch[1].replace(/<[^>]+>/g, "").trim()
      : `Publicación ${articleId}`;

    // Buscar fecha de publicación
    const fechaMatch = html.match(/Fecha de publicaci[oó]n[\s\S]*?(\d{1,2}\s+\w+\s+\d{4})/i)
      || html.match(/(\d{4}-\d{2}-\d{2})/);
    const fechaPub = fechaMatch ? fechaMatch[1].trim() : "";

    // Buscar documentos que coincidan con el fragmento del radicado
    // Los documentos aparecen como links: <a href="...">2023-00682 AutoAdmiteDemanda.pdf</a>
    const regexDoc = new RegExp(
      `href="([^"]*)"[^>]*>\\s*(${fragmento.replace("-", "[-_]")}[^<]*\\.pdf)`,
      "gi"
    );

    const documentos = [];
    let md;
    while ((md = regexDoc.exec(html)) !== null) {
      documentos.push({
        url: md[1].startsWith("http") ? md[1] : `${MICROSITIO_BASE}${md[1]}`,
        nombre: md[2].trim(),
      });
    }

    // También buscar en los nombres de archivo sin href exacto
    if (documentos.length === 0) {
      const regexNombre = new RegExp(
        `(${fragmento.replace("-", "[-_]")}[\\w\\s\\-\\.]+\\.pdf)`,
        "gi"
      );
      let mn;
      while ((mn = regexNombre.exec(html)) !== null) {
        documentos.push({ url: "", nombre: mn[1].trim() });
      }
    }

    if (documentos.length > 0) {
      console.log(`      [micrositio] ✓ Documentos del proceso en "${tituloPub}": ${documentos.map(d => d.nombre).join(", ")}`);
    }

    return {
      articleId,
      tituloPub,
      fechaPub,
      documentos,
    };
  } catch (err) {
    console.error(`[buscarDocumentosEnPublicacion] articleId=${articleId}:`, err.message);
    return null;
  }
}

// 2f. Función principal del micrositio: dado un radicado,
//     retorna las publicaciones que mencionan ese proceso
async function consultarMicrositio(numeroRadicado) {
  const parsed = parsearRadicado(numeroRadicado);
  if (!parsed) {
    console.log(`      [micrositio] Radicado inválido para parsear: ${numeroRadicado}`);
    return [];
  }

  console.log(`      [micrositio] Consultando despacho ${parsed.codigoDespacho}, proceso ${parsed.fragmentoBusqueda}`);

  // Paso 1: obtener lista de publicaciones del despacho
  await sleep(1500);
  const publicaciones = await obtenerPublicacionesDespacho(parsed);
  if (publicaciones.length === 0) return [];

  // Paso 2: revisar cada publicación buscando documentos del radicado
  const resultados = [];
  for (const pub of publicaciones) {
    await sleep(1000);
    const detalle = await buscarDocumentosEnPublicacion(
      pub.articleId,
      parsed.fragmentoBusqueda,
      parsed
    );
    if (detalle && detalle.documentos.length > 0) {
      resultados.push({
        ...detalle,
        fragmento: parsed.fragmentoBusqueda,
      });
    }
    if (resultados.length >= 3) break; // máximo 3 publicaciones con resultados
  }

  return resultados;
}

// ============================================================
// SUPABASE — helpers de lectura/escritura
// ============================================================

async function actuacionYaRegistrada(radicadoId, fechaActuacion, tipoActuacion) {
  const { data, error } = await supabase
    .from("actuaciones")
    .select("id")
    .eq("radicado_id", radicadoId)
    .eq("fecha", fechaActuacion)
    .eq("tipo", tipoActuacion)
    .limit(1);
  if (error) { console.error("[actuacionYaRegistrada]", error.message); return false; }
  return data && data.length > 0;
}

async function insertarActuacion(radicadoId, actuacion) {
  const descripcion = actuacion.anotacion
    ? `${actuacion.actuacion}: ${actuacion.anotacion}`
    : actuacion.actuacion;
  const { error } = await supabase.from("actuaciones").insert({
    radicado_id: radicadoId,
    fecha: actuacion.fechaActuacion || new Date().toISOString().substring(0, 10),
    descripcion,
    tipo: actuacion.actuacion,
    es_nuevo: true,
  });
  if (error) { console.error("[insertarActuacion]", error.message); return false; }
  return true;
}

async function insertarActuacionMicrositio(radicadoId, pub) {
  // Verificar si ya está registrada por articleId o por título+fecha
  const { data: existe } = await supabase
    .from("actuaciones")
    .select("id")
    .eq("radicado_id", radicadoId)
    .eq("tipo", `MICROSITIO:${pub.articleId}`)
    .limit(1);
  if (existe && existe.length > 0) return false; // ya registrada

  const fecha = pub.fechaPub
    ? pub.fechaPub.substring(0, 10)
    : new Date().toISOString().substring(0, 10);

  const docNombres = pub.documentos.map(d => d.nombre).join("; ");
  const descripcion = `${pub.tituloPub} — Documentos: ${docNombres}`;

  const { error } = await supabase.from("actuaciones").insert({
    radicado_id: radicadoId,
    fecha,
    descripcion,
    tipo: `MICROSITIO:${pub.articleId}`,
    es_nuevo: true,
  });
  if (error) { console.error("[insertarActuacionMicrositio]", error.message); return false; }
  return true;
}

async function insertarTermino(radicadoId, actuacionId, fechaVence) {
  if (!fechaVence || fechaVence === "0001-01-01" || fechaVence === "") return;
  const hoy = new Date();
  const vence = new Date(fechaVence);
  const diasRestantes = Math.ceil((vence - hoy) / (1000 * 60 * 60 * 24));
  const estado = diasRestantes < 0 ? "vencido"
    : diasRestantes <= 5 ? "urgente"
    : diasRestantes <= 15 ? "proximo"
    : "vigente";
  const { error } = await supabase.from("terminos").insert({
    radicado_id: radicadoId,
    actuacion_id: actuacionId,
    descripcion: `Término vence: ${fechaVence}`,
    fecha_vence: fechaVence,
    dias_restantes: diasRestantes,
    estado,
  });
  if (error) console.error("[insertarTermino]", error.message);
}

async function obtenerIdActuacionReciente(radicadoId, fecha, tipo) {
  const { data, error } = await supabase
    .from("actuaciones")
    .select("id")
    .eq("radicado_id", radicadoId)
    .eq("fecha", fecha)
    .eq("tipo", tipo)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

// ============================================================
// PROCESO PRINCIPAL
// ============================================================
async function sincronizar() {
  console.log("=".repeat(60));
  console.log(`[SYNC] Inicio: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  console.log("=".repeat(60));

  const { data: radicados, error } = await supabase
    .from("radicados")
    .select(`
      id, numero, nombre, despacho, tipo, cliente_id,
      clientes ( nombre, email, activo, plan_vence )
    `)
    .eq("activo", true);

  if (error) {
    console.error("[SYNC] Error cargando radicados:", error.message);
    return;
  }

  console.log(`[SYNC] Radicados activos: ${radicados.length}`);

  let nuevasRama = 0;
  let nuevasMicro = 0;
  let sinNovedad  = 0;
  let errores     = 0;

  for (const radicado of radicados) {
    const cliente = radicado.clientes;

    if (!cliente?.activo) {
      console.log(`  [SKIP] ${radicado.numero} — cliente inactivo`);
      continue;
    }
    if (cliente?.plan_vence && new Date(cliente.plan_vence) < new Date()) {
      console.log(`  [SKIP] ${radicado.numero} — plan vencido (${cliente.plan_vence})`);
      continue;
    }

    console.log(`\n  [→] Procesando: ${radicado.numero}`);

    // ── FUENTE 1: API Rama Judicial ────────────────────────────
    try {
      const idProceso = await obtenerIdProceso(radicado.numero);
      if (!idProceso) {
        console.log(`      [!] No se encontró idProceso para ${radicado.numero}`);
        errores++;
      } else {
        await sleep(1500);
        const ultimaAct = await obtenerUltimaActuacion(idProceso);
        if (!ultimaAct || !ultimaAct.fechaActuacion) {
          console.log(`      [!] Sin actuaciones disponibles en API`);
          sinNovedad++;
        } else {
          console.log(`      [API] Última actuación: ${ultimaAct.actuacion} (${ultimaAct.fechaActuacion})`);
          const yaRegistrada = await actuacionYaRegistrada(
            radicado.id, ultimaAct.fechaActuacion, ultimaAct.actuacion
          );
          if (yaRegistrada) {
            console.log(`      [=] Sin novedad — ya registrada`);
            sinNovedad++;
          } else {
            const insertada = await insertarActuacion(radicado.id, ultimaAct);
            if (insertada) {
              console.log(`      [✓] Nueva actuación (API) registrada`);
              nuevasRama++;
              if (ultimaAct.fechaFinTermino && ultimaAct.fechaFinTermino !== "0001-01-01") {
                const aid = await obtenerIdActuacionReciente(
                  radicado.id, ultimaAct.fechaActuacion, ultimaAct.actuacion
                );
                if (aid) {
                  await insertarTermino(radicado.id, aid, ultimaAct.fechaFinTermino);
                  console.log(`      [⏰] Término registrado: vence ${ultimaAct.fechaFinTermino}`);
                }
              }
            } else {
              errores++;
            }
          }
        }
      }
    } catch (err) {
      console.error(`      [ERROR API] ${radicado.numero}:`, err.message);
      errores++;
    }

    // ── FUENTE 2: Micrositio Publicaciones Procesales ──────────
    // Solo aplica para radicados de 23 dígitos (todos los civiles)
    if (radicado.numero && radicado.numero.replace(/\s/g, "").length === 23) {
      try {
        await sleep(2000);
        const pubsMicro = await consultarMicrositio(radicado.numero);
        if (pubsMicro.length > 0) {
          for (const pub of pubsMicro) {
            const insertada = await insertarActuacionMicrositio(radicado.id, pub);
            if (insertada) {
              console.log(`      [✓] Nueva publicación (micrositio) registrada: ${pub.tituloPub}`);
              nuevasMicro++;
            }
          }
        } else {
          console.log(`      [micrositio] Sin publicaciones nuevas para este proceso`);
        }
      } catch (err) {
        console.error(`      [ERROR MICROSITIO] ${radicado.numero}:`, err.message);
      }
    }

    await sleep(2000);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`[SYNC] Fin: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  console.log(`       Nuevas actuaciones (API)        : ${nuevasRama}`);
  console.log(`       Nuevas publicaciones (micrositio): ${nuevasMicro}`);
  console.log(`       Sin novedad                      : ${sinNovedad}`);
  console.log(`       Errores                          : ${errores}`);
  console.log("=".repeat(60));
}

// ── PUNTO DE ENTRADA ──────────────────────────────────────────
sincronizar().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});

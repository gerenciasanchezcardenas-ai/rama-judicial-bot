// PDF del Perfil Jurídico y Patrimonial. Se genera en memoria a partir de la solicitud guardada,
// de modo que el enlace del reporte sigue sirviendo aunque el servidor se reinicie.
const PDFDocument = require("pdfkit");

const NAVY = "#0d1b2a";
const GOLD = "#b8973a";
const INK = "#1d2733";
const GRAY = "#5d6876";
const LINE = "#e3dccd";
const RED = "#a33a3a";

const fmtCOP = (n) => "$" + Math.round(n || 0).toLocaleString("es-CO");
const fmtFecha = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00-05:00" : iso);
  return d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Bogota" });
};
const fmtFechaHora = (iso) =>
  new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });

const sinTildes = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

// ¿El nombre consultado aparece entre estas partes? Todas sus palabras deben estar presentes.
function figuraEn(nombre, lista) {
  const palabras = sinTildes(nombre).split(/\s+/).filter((w) => w.length > 2);
  return lista.some((parte) => {
    const p = sinTildes(parte);
    return palabras.length > 0 && palabras.every((w) => p.includes(w));
  });
}

function posicion(nombre, proceso) {
  if (figuraEn(nombre, proceso.demandados)) return "Demandado";
  if (figuraEn(nombre, proceso.demandantes)) return "Demandante";
  return "Sujeto procesal";
}

function especialidad(despacho) {
  const d = sinTildes(despacho);
  if (d.includes("LABORAL")) return "laboral";
  if (d.includes("FAMILIA")) return "familia";
  if (d.includes("PENAL")) return "penal";
  if (d.includes("ADMINISTRATIV")) return "administrativo";
  if (d.includes("CIVIL") || d.includes("PEQUENAS CAUSAS") || d.includes("PROMISCUO")) return "civil";
  return "";
}

function generarPDF(sol, ahora = new Date()) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: "Perfil Jurídico y Patrimonial" } });
    const partesBuf = [];
    doc.on("data", (c) => partesBuf.push(c));
    doc.on("end", () => resolve(Buffer.concat(partesBuf)));
    doc.on("error", reject);

    const W = doc.page.width - 100;
    const espacio = (alto) => { if (doc.y + alto > doc.page.height - 70) doc.addPage(); };
    const titulo = (t) => {
      espacio(60);
      doc.moveDown(0.8);
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12.5).text(t.toUpperCase(), 50, doc.y, { width: W });
      doc.moveTo(50, doc.y + 3).lineTo(50 + W, doc.y + 3).strokeColor(GOLD).lineWidth(1).stroke();
      doc.moveDown(0.6);
    };
    const campo = (etiqueta, valor, color = INK) => {
      if (!valor) return;
      espacio(16);
      doc.font("Helvetica").fontSize(9).fillColor(GRAY).text(etiqueta + ": ", 60, doc.y, { continued: true, width: W - 10 })
        .font("Helvetica-Bold").fillColor(color).text(String(valor));
    };
    const parrafo = (t, opts = {}) => {
      espacio(30);
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size || 9.5).fillColor(opts.color || INK)
        .text(t, opts.x || 50, doc.y, { width: opts.width || W, align: "justify", lineGap: 1.5 });
    };

    // ── Encabezado ──
    doc.rect(0, 0, doc.page.width, 105).fill(NAVY);
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(18).text("SÁNCHEZ & CÁRDENAS CONSULTING S.A.S.", 50, 32);
    doc.fillColor("#e8e2d4").font("Helvetica").fontSize(9.5).text("Abogados  |  Bogotá  ·  Sabana Centro  ·  Cali  ·  Pereira", 50, 58);
    doc.fillColor(GOLD).fontSize(9).text("sanchezcardenasconsulting.com  |  +57 313 829 1633", 50, 74);
    doc.rect(0, 105, doc.page.width, 3).fill(GOLD);

    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(17).text("PERFIL JURÍDICO Y PATRIMONIAL", 50, 130, { width: W, align: "center" });
    doc.moveDown(0.3);
    doc.fillColor(GRAY).font("Helvetica").fontSize(9).text("Informe elaborado con información de fuentes públicas oficiales", { width: W, align: "center" });

    // ── Ficha de la consulta ──
    doc.moveDown(1);
    const yFicha = doc.y;
    doc.rect(50, yFicha, W, 86).fill("#f7f4ee");
    doc.y = yFicha + 10;
    campo("Persona consultada", sol.nombre.toUpperCase(), NAVY);
    campo("Documento", sol.tipo_documento + " " + sol.documento);
    campo("Tipo de persona", sol.tipo_persona === "jur" ? "Jurídica" : "Natural");
    campo("Fecha de la consulta", fmtFechaHora(sol.created_at || ahora));
    campo("Referencia", sol.referencia);
    doc.y = yFicha + 96;

    // ── 1. Rama Judicial ──
    const rama = sol.resultado_rama || {};
    const procesos = rama.procesos || [];
    titulo("1. Procesos judiciales (Rama Judicial)");
    if (rama.ok === false) {
      parrafo("El sistema de consulta de la Rama Judicial no respondió en el momento de la consulta. La firma repetirá la búsqueda y la incluirá en el complemento de este informe.", { color: RED });
    } else if (rama.demasiados) {
      parrafo("La búsqueda por este nombre arrojó más de mil coincidencias, por lo que la Rama Judicial no entrega el listado. La firma depurará la búsqueda y la incluirá en el complemento de este informe.");
    } else if (procesos.length === 0) {
      parrafo("No se encontraron procesos registrados a nombre de la persona consultada en la Consulta Nacional Unificada de Procesos.");
    } else {
      parrafo(`Se encontraron ${rama.total || procesos.length} proceso(s) en los que figura un sujeto procesal con el nombre consultado.` +
        (rama.total > procesos.length ? ` Se detallan los ${procesos.length} más recientes.` : ""));
      procesos.forEach((p, i) => {
        espacio(110);
        doc.moveDown(0.6);
        doc.rect(50, doc.y, 3, 12).fill(GOLD);
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text(`${i + 1}. Radicado ${p.radicado}`, 58, doc.y + 1, { width: W - 8 });
        doc.moveDown(0.2);
        campo("Despacho", p.despacho);
        campo("Departamento", p.departamento);
        campo("Posición de la persona consultada", posicion(sol.nombre, p));
        if (p.demandantes.length) campo("Demandante(s)", p.demandantes.join(" / "));
        if (p.demandados.length) campo("Demandado(s)", p.demandados.join(" / "));
        campo("Fecha de radicación", fmtFecha(p.fechaRadicacion));
        campo("Última actuación registrada", fmtFecha(p.fechaUltimaActuacion));
        if (p.ultimaActuacion) {
          campo("Actuación", p.ultimaActuacion.actuacion);
          if (p.ultimaActuacion.anotacion) campo("Anotación", p.ultimaActuacion.anotacion);
          if (p.ultimaActuacion.venceTermino) campo("Término que vence", fmtFecha(p.ultimaActuacion.venceTermino), RED);
        }
      });
    }

    // ── 2. SECOP ──
    const secop = sol.resultado_secop || {};
    const contratos = secop.contratos || [];
    titulo("2. Contratos con entidades públicas (SECOP II)");
    if (secop.ok === false) {
      parrafo("La plataforma de datos abiertos del SECOP no respondió en el momento de la consulta. La firma repetirá la búsqueda y la incluirá en el complemento.", { color: RED });
    } else if (contratos.length === 0) {
      parrafo("No se encontraron contratos suscritos con entidades públicas registrados en el SECOP II a nombre del documento consultado.");
    } else {
      const pendiente = contratos.reduce((s, c) => s + c.valorPendientePago, 0);
      parrafo(`Se encontraron ${contratos.length} contrato(s) con entidades públicas. Según el SECOP II, el saldo pendiente de pago a favor de la persona consultada suma ${fmtCOP(pendiente)}.`);
      contratos.forEach((c, i) => {
        espacio(120);
        doc.moveDown(0.6);
        doc.rect(50, doc.y, 3, 12).fill(GOLD);
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text(`${i + 1}. ${c.entidad}`, 58, doc.y + 1, { width: W - 8 });
        doc.moveDown(0.2);
        campo("Contrato", [c.idContrato, c.tipo].filter(Boolean).join(" · "));
        campo("Estado", c.estado);
        campo("Objeto", c.objeto);
        campo("Firma y terminación", [fmtFecha(c.fechaFirma), fmtFecha(c.fechaFin)].filter(Boolean).join(" a "));
        campo("Valor del contrato", fmtCOP(c.valor));
        campo("Valor pagado", fmtCOP(c.valorPagado));
        if (c.valorPendientePago > 0) campo("Pendiente de pago", fmtCOP(c.valorPendientePago), RED);
        if (c.banco) campo("Cuenta registrada para pagos", [c.banco, c.tipoCuenta, c.cuenta].filter(Boolean).join(", "));
      });
    }

    // ── 3. Supernotariado ──
    titulo("3. Bienes inmuebles (Superintendencia de Notariado y Registro)");
    if (sol.snr_resultado) {
      parrafo(sol.snr_resultado);
      (sol.snr_matriculas || []).forEach((m) => campo("Matrícula inmobiliaria", [m.matricula, m.oficina, m.descripcion].filter(Boolean).join(" · ")));
    } else {
      parrafo("La consulta del índice de propietarios la realiza directamente un integrante de la firma. El resultado se entregará como complemento de este informe" +
        (sol.snr_vence_at ? `, a más tardar el ${fmtFechaHora(sol.snr_vence_at).replace(/\.$/, "")}.` : ", dentro de las 12 horas siguientes a la confirmación del pago."));
    }

    // ── 4. Observaciones para la gestión ──
    titulo("4. Observaciones para la gestión");
    const obs = [];
    const pendiente = contratos.reduce((s, c) => s + c.valorPendientePago, 0);
    if (pendiente > 0) obs.push(`La persona consultada tiene saldos por cobrar a entidades públicas por ${fmtCOP(pendiente)}. En un proceso ejecutivo, esos créditos pueden ser objeto de embargo conforme al numeral 4 del artículo 593 del Código General del Proceso, con los límites legales de inembargabilidad que apliquen.`);
    if (contratos.some((c) => c.banco)) obs.push("El SECOP registra las entidades bancarias donde la persona consultada recibe pagos. Ese dato orienta la solicitud de embargo de sumas depositadas (numeral 10 del artículo 593 del Código General del Proceso).");
    const comoDemandado = procesos.filter((p) => posicion(sol.nombre, p) === "Demandado");
    if (comoDemandado.length) obs.push(`La persona consultada figura como demandada en ${comoDemandado.length} proceso(s). Conviene revisar si en ellos existen embargos o remanentes decretados, porque inciden en la prelación y en la posibilidad real de recaudo.`);
    if (procesos.some((p) => especialidad(p.despacho) === "laboral" && posicion(sol.nombre, p) === "Demandado")) obs.push("Hay procesos laborales en contra. Los créditos laborales gozan de prelación sobre los quirografarios.");
    if (!obs.length) obs.push("Con la información disponible no se identificaron procesos ni contratos públicos que orienten medidas cautelares. El resultado de la Supernotariado completará el panorama patrimonial.");
    obs.forEach((t) => { parrafo("•  " + t); doc.moveDown(0.3); });

    // ── Nota final ──
    titulo("Alcance de este informe");
    parrafo("Este informe recoge la información que la Rama Judicial y el SECOP II tenían publicada en la fecha y hora de la consulta, y la que la Superintendencia de Notariado y Registro entregue al momento de la búsqueda. No es un certificado oficial de ninguna de esas entidades. La búsqueda de procesos se hace por nombre, de manera que pueden aparecer homónimos; la firma recomienda verificar cada radicado antes de tomar decisiones. Los procesos con reserva legal no se publican.", { size: 8.5, color: GRAY });
    doc.moveDown(0.8);
    espacio(60);
    const yCta = doc.y;
    doc.rect(50, yCta, W, 52).fill("#f0ece0");
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5).text("¿Necesita iniciar el cobro o defenderse?", 62, yCta + 10);
    doc.fillColor(INK).font("Helvetica").fontSize(9).text("Escríbanos al +57 313 829 1633 o a gerenciasanchezcardenas@gmail.com, citando la referencia de este informe.", 62, yCta + 27, { width: W - 24 });

    // ── Pie en cada página ──
    const rango = doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // evita que el pie abra una página nueva
      doc.rect(0, doc.page.height - 32, doc.page.width, 32).fill(NAVY);
      doc.fillColor(GOLD).font("Helvetica").fontSize(7.5).text(
        `Sánchez & Cárdenas Consulting S.A.S.  ·  Perfil Jurídico y Patrimonial  ·  Ref. ${sol.referencia}  ·  Página ${i + 1} de ${rango.count}`,
        50, doc.page.height - 20, { width: W, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { generarPDF, posicion, figuraEn };

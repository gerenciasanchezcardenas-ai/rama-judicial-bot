// Herramienta interna de la firma: carga del resultado de la Supernotariado y envío del complemento.
// Protegida con la clave ADMIN_CLAVE (variable de entorno en Render).
const express = require("express");
const crypto = require("crypto");

const hash = (s) => crypto.createHash("sha256").update(String(s || "")).digest();

module.exports = function crearAdmin({ db, enviar, BASE_URL }) {
  const router = express.Router();
  const CLAVE = process.env.ADMIN_CLAVE || "";

  function autorizado(req) {
    if (!CLAVE) return false;
    const dada = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    return crypto.timingSafeEqual(hash(dada), hash(CLAVE));
  }
  const proteger = (req, res, next) => (autorizado(req) ? next() : res.status(401).json({ error: "Clave incorrecta" }));

  router.get("/admin", (req, res) => res.type("html").send(PAGINA));

  router.get("/admin/api/pendientes", proteger, async (req, res) => {
    try {
      const [pendientes, recientes] = await Promise.all([db.solicitudesParaSNR(), db.complementosRecientes()]);
      res.json({ pendientes, recientes });
    } catch (e) {
      console.error("Error listando pendientes:", e.message);
      res.status(500).json({ error: "No fue posible leer las solicitudes" });
    }
  });

  router.post("/admin/api/complemento", proteger, async (req, res) => {
    try {
      const { referencia, resultado, observacion, cargadoPor } = req.body || {};
      const matriculas = (Array.isArray(req.body.matriculas) ? req.body.matriculas : [])
        .map((m) => ({
          matricula: String(m.matricula || "").trim().toUpperCase(),
          oficina: String(m.oficina || "").trim(),
          descripcion: String(m.descripcion || "").trim().slice(0, 300),
        }))
        .filter((m) => m.matricula);

      if (!cargadoPor || !String(cargadoPor).trim()) return res.status(400).json({ error: "Escriba su nombre" });
      if (!["sin", "con"].includes(resultado)) return res.status(400).json({ error: "Indique si encontró inmuebles" });
      if (resultado === "con" && !matriculas.length) return res.status(400).json({ error: "Agregue al menos una matrícula" });
      const malas = matriculas.filter((m) => !/^[0-9]{2,3}[A-Z]?-?[0-9]{1,9}$/.test(m.matricula.replace(/\s/g, "")));
      if (malas.length) return res.status(400).json({ error: "Revise el formato de: " + malas.map((m) => m.matricula).join(", ") });

      const sol = await db.solicitudPorReferencia(referencia);
      if (!sol || !["pagado", "reporte_enviado"].includes(sol.estado)) {
        return res.status(409).json({ error: "Esta solicitud ya no está pendiente" });
      }

      const fecha = new Date().toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Bogota" });
      let texto = resultado === "sin"
        ? `Consultado el índice de propietarios de la Superintendencia de Notariado y Registro el ${fecha}, no se encontraron inmuebles registrados a nombre de la persona consultada.`
        : `Consultado el índice de propietarios de la Superintendencia de Notariado y Registro el ${fecha}, se encontraron ${matriculas.length} inmueble(s) registrados a nombre de la persona consultada, identificados con las siguientes matrículas inmobiliarias.`;
      if (observacion && String(observacion).trim()) texto += " " + String(observacion).trim().slice(0, 800);

      const actualizada = await db.actualizarSolicitud(referencia, {
        snr_resultado: texto,
        snr_matriculas: resultado === "con" ? matriculas : [],
        snr_cargado_por: String(cargadoPor).trim().slice(0, 80),
        estado: "complemento_enviado",
        complemento_at: new Date().toISOString(),
      }, sol.estado);
      if (!actualizada) return res.status(409).json({ error: "Otra persona acaba de cargar esta solicitud" });

      const resumen = resultado === "sin"
        ? "No se encontraron inmuebles registrados a nombre de la persona consultada."
        : `Se encontraron *${matriculas.length} inmueble(s)* registrados a nombre de la persona consultada.`;
      let enviado = true;
      try {
        await enviar(sol.telefono,
          `🏠 *Complemento de su Perfil Jurídico y Patrimonial*\n\nPersona consultada: ${sol.nombre.toUpperCase()}\n` +
          `Resultado en la Supernotariado: ${resumen}\n\nLe enviamos el informe actualizado con la sección de bienes inmuebles.\n\nReferencia: ${sol.referencia}`,
          `${BASE_URL}/reporte/${sol.token_reporte}.pdf`);
      } catch (e) {
        enviado = false;
      }
      res.json({ ok: true, enviado });
    } catch (e) {
      console.error("Error cargando complemento:", e.message);
      res.status(500).json({ error: "No fue posible guardar el complemento" });
    }
  });

  return router;
};

const PAGINA = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Supernotariado · Perfil Jurídico</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--navy:#0d1b2a;--gold:#b8973a;--paper:#f7f4ee;--ink:#1d2733;--muted:#5d6876;--line:#e3dccd;--red:#a33a3a;--amber:#b7791f;--green:#2f7d4f}
*{box-sizing:border-box}body{margin:0;font-family:'DM Sans',sans-serif;background:var(--paper);color:var(--ink)}
header{background:var(--navy);color:#fff;padding:18px 20px;border-bottom:3px solid var(--gold)}
header h1{font-family:'Cormorant Garamond',serif;font-size:1.5rem;margin:0}header p{margin:4px 0 0;color:#c9d2dc;font-size:.88rem}
main{max-width:900px;margin:0 auto;padding:20px 16px 60px}
.box{background:#fff;border:1px solid var(--line);padding:18px;margin-bottom:16px}
label{display:block;font-size:.8rem;font-weight:600;color:var(--navy);margin:10px 0 4px}
input,textarea,select{width:100%;padding:9px 10px;border:1px solid #cfc6b3;font:inherit;font-size:.92rem;background:#fff}
textarea{min-height:60px}
button{border:0;background:var(--navy);color:#fff;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}
button.gold{background:var(--gold);color:var(--navy)}button.link{background:none;color:var(--navy);padding:4px 0;text-decoration:underline}
button:disabled{opacity:.5;cursor:default}
h2{font-family:'Cormorant Garamond',serif;color:var(--navy);font-size:1.4rem;margin:24px 0 10px}
.card{background:#fff;border:1px solid var(--line);border-left:5px solid var(--green);padding:14px 16px;margin-bottom:12px}
.card.amber{border-left-color:var(--amber)}.card.red{border-left-color:var(--red)}
.card .top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.card strong{color:var(--navy);font-size:1.02rem}.meta{color:var(--muted);font-size:.85rem;margin-top:3px}
.vence{font-weight:600;font-size:.85rem;white-space:nowrap}.red .vence{color:var(--red)}.amber .vence{color:var(--amber)}.vence{color:var(--green)}
.form{display:none;border-top:1px dashed var(--line);margin-top:12px;padding-top:8px}.open .form{display:block}
.radios{display:flex;gap:18px;margin-top:6px}.radios label{display:flex;gap:6px;align-items:center;font-weight:500;margin:0}.radios input{width:auto}
.mat{display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:6px;margin-top:6px}
.msg{font-size:.88rem;margin-top:8px}.msg.err{color:var(--red)}.msg.ok{color:var(--green)}
.copy{font-family:monospace;background:var(--paper);padding:2px 6px;cursor:pointer;border:1px solid var(--line)}
.hidden{display:none}table{width:100%;border-collapse:collapse;font-size:.86rem;background:#fff}
td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line)}th{color:var(--navy)}
@media(max-width:620px){.mat{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Perfil Jurídico y Patrimonial</h1><p>Consultas pendientes en la Supernotariado · Uso interno de la firma</p></header>
<main>
<div id="login" class="box">
  <label for="clave">Clave de acceso</label><input id="clave" type="password" autocomplete="current-password">
  <label for="quien">Su nombre (queda registrado en cada carga)</label><input id="quien" autocomplete="name">
  <div style="margin-top:12px"><button id="entrar">Entrar</button></div><div id="loginMsg" class="msg err"></div>
</div>
<div id="app" class="hidden">
  <div style="display:flex;justify-content:space-between;align-items:center"><h2>Pendientes</h2><button class="link" id="recargar">Actualizar</button></div>
  <div id="pendientes"></div>
  <h2>Complementos enviados recientemente</h2><div id="recientes"></div>
  <p class="meta" style="margin-top:20px">Para consultar: certificados.supernotariado.gov.co → Consultas generales → Índice de propietarios. Copie el documento haciendo clic sobre él.</p>
</div>
</main>
<script>
let CLAVE="",QUIEN="";
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
const fecha=iso=>iso?new Date(iso).toLocaleString("es-CO",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit",timeZone:"America/Bogota"}):"";
try{CLAVE=sessionStorage.getItem("pjp_clave")||"";QUIEN=sessionStorage.getItem("pjp_quien")||""}catch(e){}
async function api(ruta,opts={}){
  const r=await fetch(ruta,{...opts,headers:{"Content-Type":"application/json",Authorization:"Bearer "+CLAVE}});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||"Error"),{status:r.status});return j}
async function cargar(){
  try{const {pendientes,recientes}=await api("/admin/api/pendientes");
    $("#login").classList.add("hidden");$("#app").classList.remove("hidden");pintar(pendientes,recientes)}
  catch(e){$("#app").classList.add("hidden");$("#login").classList.remove("hidden");if(e.status===401&&CLAVE)$("#loginMsg").textContent="Clave incorrecta."}}
function pintar(p,r){
  const ahora=Date.now();
  $("#pendientes").innerHTML=p.length?p.map(s=>{
    const h=(new Date(s.snr_vence_at)-ahora)/36e5;const cls=h<0?"red":h<3?"amber":"";
    const txt=h<0?"Vencida hace "+Math.ceil(-h)+" h":"Vence "+fecha(s.snr_vence_at);
    return '<div class="card '+cls+'" data-ref="'+esc(s.referencia)+'"><div class="top"><div><strong>'+esc(s.nombre.toUpperCase())+'</strong>'+
    '<div class="meta">'+esc(s.tipo_documento)+' <span class="copy" title="Copiar">'+esc(s.documento)+'</span> · '+(s.tipo_persona==="jur"?"Persona jurídica":"Persona natural")+' · Ref. '+esc(s.referencia)+'</div>'+
    '<div class="meta">Pagó: '+fecha(s.pagado_at)+'</div></div><div><div class="vence">'+txt+'</div><button class="link abrir">Cargar resultado</button></div></div>'+
    '<div class="form"><label>Resultado de la consulta</label><div class="radios"><label><input type="radio" name="r-'+esc(s.referencia)+'" value="sin"> Sin inmuebles</label><label><input type="radio" name="r-'+esc(s.referencia)+'" value="con"> Con inmuebles</label></div>'+
    '<div class="mats hidden"><label>Matrículas (círculo-número · oficina de registro · descripción o dirección)</label><div class="filas"></div><button class="link agregar" type="button">+ Agregar matrícula</button></div>'+
    '<label>Observación para el cliente (opcional)</label><textarea class="obs" maxlength="800"></textarea>'+
    '<div style="margin-top:10px"><button class="gold enviar">Enviar complemento al cliente</button></div><div class="msg"></div></div></div>'}).join(""):'<div class="box meta">No hay consultas pendientes.</div>';
  $("#recientes").innerHTML=r.length?'<table><tr><th>Persona</th><th>Enviado</th><th>Plazo</th><th>Cargó</th></tr>'+r.map(s=>
    '<tr><td>'+esc(s.nombre)+'</td><td>'+fecha(s.complemento_at)+'</td><td>'+(new Date(s.complemento_at)<=new Date(s.snr_vence_at)?"A tiempo":"Fuera de plazo")+'</td><td>'+esc(s.snr_cargado_por||"")+'</td></tr>').join("")+'</table>':'<div class="meta">Todavía no hay complementos enviados.</div>'}
function fila(){const d=document.createElement("div");d.className="mat";
  d.innerHTML='<input placeholder="50C-1234567" class="m"><input placeholder="Bogotá Zona Centro" class="o"><input placeholder="Apartamento 301, Calle 10 # 5-20" class="d"><button class="link quitar" type="button">Quitar</button>';return d}
document.addEventListener("click",async e=>{
  const card=e.target.closest(".card");
  if(e.target.classList.contains("copy")){try{await navigator.clipboard.writeText(e.target.textContent);e.target.textContent+=" ✓"}catch(_){}return}
  if(e.target.classList.contains("abrir")){card.classList.toggle("open");return}
  if(e.target.classList.contains("agregar")){card.querySelector(".filas").appendChild(fila());return}
  if(e.target.classList.contains("quitar")){e.target.parentElement.remove();return}
  if(e.target.classList.contains("enviar")){
    const msg=card.querySelector(".form .msg");msg.className="msg";msg.textContent="";
    const sel=card.querySelector('input[type=radio]:checked');
    const matriculas=[...card.querySelectorAll(".mat")].map(f=>({matricula:f.querySelector(".m").value,oficina:f.querySelector(".o").value,descripcion:f.querySelector(".d").value}));
    if(!sel){msg.className="msg err";msg.textContent="Indique si encontró inmuebles.";return}
    if(!confirm("Se enviará el complemento por WhatsApp al cliente. ¿Continuar?"))return;
    e.target.disabled=true;
    try{const j=await api("/admin/api/complemento",{method:"POST",body:JSON.stringify({referencia:card.dataset.ref,resultado:sel.value,matriculas,observacion:card.querySelector(".obs").value,cargadoPor:QUIEN})});
      msg.className="msg ok";msg.textContent=j.enviado?"Complemento enviado.":"Guardado, pero WhatsApp no confirmó el envío. Avise al cliente por otro medio.";setTimeout(cargar,1500)}
    catch(err){msg.className="msg err";msg.textContent=err.message;e.target.disabled=false}}});
document.addEventListener("change",e=>{if(e.target.type==="radio"){const c=e.target.closest(".card");const con=e.target.value==="con";
  c.querySelector(".mats").classList.toggle("hidden",!con);if(con&&!c.querySelector(".mat"))c.querySelector(".filas").appendChild(fila())}});
$("#entrar").onclick=()=>{CLAVE=$("#clave").value;QUIEN=$("#quien").value.trim();if(!QUIEN){$("#loginMsg").textContent="Escriba su nombre.";return}
  try{sessionStorage.setItem("pjp_clave",CLAVE);sessionStorage.setItem("pjp_quien",QUIEN)}catch(e){}cargar()};
$("#recargar").onclick=cargar;
if(CLAVE&&QUIEN)cargar();setInterval(()=>{if(CLAVE&&!$("#app").classList.contains("hidden")&&!document.querySelector(".card.open"))cargar()},60000);
</script></body></html>`;

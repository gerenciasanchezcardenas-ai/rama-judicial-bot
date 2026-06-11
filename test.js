/**
 * ============================================================
 * Script de prueba — Consulta Rama Judicial
 * Ejecutar con: node test.js
 * ============================================================
 */

const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

async function ejecutarPruebas() {
  console.log("=".repeat(60));
  console.log("  SÁNCHEZ & CÁRDENAS — Prueba de consulta Rama Judicial");
  console.log("=".repeat(60) + "\n");

  // ── Prueba 1: Nombre de persona ──────────────────────────
  console.log("📋 PRUEBA 1: Búsqueda por nombre");
  console.log("   Buscando: JUAN CAMILO PEREZ GARCIA\n");

  const resultado1 = await consultarPorNombre("JUAN CAMILO PEREZ GARCIA");

  console.log("   Estado:", resultado1.exito ? "✅ Exitoso" : "❌ Error");
  console.log("   Encontrado:", resultado1.encontrado);
  console.log("   Total procesos:", resultado1.total);
  console.log("\n   Mensaje para WhatsApp:");
  console.log("   " + "-".repeat(50));
  console.log(resultado1.mensaje.replace(/\n/g, "\n   "));
  console.log("   " + "-".repeat(50));

  console.log("\n" + "=".repeat(60) + "\n");

  // ── Prueba 2: Número de radicado ─────────────────────────
  console.log("📋 PRUEBA 2: Búsqueda por radicado");
  console.log("   Radicado: 11001400305120180013500\n");

  const resultado2 = await consultarPorRadicado("11001400305120180013500");

  console.log("   Estado:", resultado2.exito ? "✅ Exitoso" : "❌ Error");
  console.log("   Encontrado:", resultado2.encontrado);
  console.log("   Total procesos:", resultado2.total);
  console.log("\n   Mensaje para WhatsApp:");
  console.log("   " + "-".repeat(50));
  console.log(resultado2.mensaje.replace(/\n/g, "\n   "));
  console.log("   " + "-".repeat(50));

  console.log("\n" + "=".repeat(60));
  console.log("  Pruebas completadas");
  console.log("=".repeat(60) + "\n");
}

ejecutarPruebas().catch(console.error);

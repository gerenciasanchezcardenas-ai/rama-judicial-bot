/**
 * ============================================================
 * SÁNCHEZ & CÁRDENAS CONSULTING S.A.S.
 * Servidor Webhook — Integración con Respond.io / WhatsApp
 * ============================================================
 *
 * Este servidor recibe los mensajes del bot de Respond.io,
 * consulta la Rama Judicial y devuelve el resultado.
 *
 * CÓMO USAR:
 *   1. Copiar .env.example a .env y completar los valores
 *   2. node server.js
 *   3. Exponer con ngrok: ngrok http 3000
 *   4. Pegar la URL de ngrok en el webhook de Respond.io
 * ============================================================
 */

require("dotenv").config();
const express = require("express");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// ── Middleware: verificar token de seguridad ─────────────────
app.use("/webhook", (req, res, next) => {
  const token = req.headers["x-webhook-secret"] || req.query.secret;
  if (WEBHOOK_SECRET && token !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
});

// ── Endpoint principal: recibe mensaje de Respond.io ────────
app.post("/webhook/consulta", async (req, res) => {
  try {
    const { texto, tipo } = req.body;
    // tipo: "nombre" | "radicado"
    // texto: lo que escribió el usuario en WhatsApp

    if (!texto) {
      return res.status(400).json({
        error: "Falta el campo 'texto'",
        mensaje:
          "Por favor envíe el nombre completo o número de radicado a consultar.",
      });
    }

    console.log(`[${new Date().toISOString()}] Consulta — tipo: ${tipo || "nombre"}, texto: ${texto}`);

    let resultado;

    if (tipo === "radicado" || esRadicado(texto)) {
      resultado = await consultarPorRadicado(texto);
    } else {
      resultado = await consultarPorNombre(texto);
    }

    // Respond.io leerá el campo "mensaje" y lo enviará al usuario
    return res.json({
      exito: resultado.exito,
      encontrado: resultado.encontrado,
      total: resultado.total || 0,
      mensaje: resultado.mensaje,
      procesos: resultado.procesos || [],
    });
  } catch (error) {
    console.error("Error en webhook:", error.message);
    return res.status(500).json({
      exito: false,
      mensaje:
        "Servicio temporalmente no disponible. Por favor intente más tarde.",
    });
  }
});

// ── Endpoint de salud (para verificar que el servidor corre) ─
app.get("/health", (req, res) => {
  res.json({
    estado: "OK",
    servicio: "Sánchez & Cárdenas — Bot Rama Judicial",
    hora: new Date().toISOString(),
  });
});

// ── Detectar si el texto parece un radicado (solo números) ───
function esRadicado(texto) {
  return /^\d{10,23}$/.test(texto.replace(/\s/g, ""));
}

// ── Iniciar servidor ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Servidor activo en http://localhost:${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook/consulta`);
  console.log(`   Salud:   http://localhost:${PORT}/health\n`);
});

module.exports = app;

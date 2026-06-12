require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { consultarPorNombre, consultarPorRadicado } = require("./ramaJudicial");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.D360_API_KEY;
const API_URL = "https://waba-sandbox.360dialog.io/v1/messages";
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const PRECIO_CONSULTA = 2000000;

const sesiones = {};
const pagosEsperados = {};

async function enviarMensaje(telefono, texto) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: "whatsapp",
        to: telefono,
        type: "text",
        text: { body: texto },
      },
      { headers: { "D360-API-KEY": API_KEY, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Error enviando mensaje:", e.message);
  }
}

async function crearEnlacePago(referencia) {
  const integrity = crypto
    .createHash("sha256")
    .update(`${referencia}${PRECIO_CONSULTA}COP${WOMPI_INTEGRITY_KEY}`)
    .digest("hex");
  return `https://checkout.wompi.co/p/?public-key=${process.env.WOMPI_PUBLIC_KEY}&currency=COP&amount-in-cents=${PRECIO_CONSULTA}&reference=${referencia}&signature:integrity=${integrity}`;
}

app.post("/webhook", async (req, res) => {
  res.json({ status: "ok" });

  try {
    const mensaje_obj = req.body?.entry?.[0]?.changes?.[0]?.valu

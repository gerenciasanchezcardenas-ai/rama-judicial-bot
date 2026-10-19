# Perfil Jurídico y Patrimonial

Bot de WhatsApp de Sánchez & Cárdenas Consulting S.A.S. que reemplaza la consulta de procesos.

## Recorrido del cliente

1. Saludo y aceptación (ACEPTO) de la finalidad de la consulta y de la política de datos.
2. Persona natural o jurídica, nombre o razón social, y cédula, CE o NIT.
3. Consulta automática en Rama Judicial (por nombre) y SECOP II (por documento).
4. Resultado preliminar gratuito con cifras y enlace de pago Wompi ($50.000).
5. Al confirmarse el pago: PDF inmediato con procesos, contratos públicos y observaciones para el cobro.
6. La firma consulta la Supernotariado y entrega el complemento dentro de 12 horas.

## Archivos

- `src/server.js`: conversación, pagos y rutas.
- `src/rama.js`: Rama Judicial (pausa de 1,5 s entre llamadas).
- `src/secop.js`: SECOP II en datos abiertos (conjunto `jbjy-vk9h`).
- `src/wompi.js`: enlace firmado, verificación de eventos y consulta de transacciones.
- `src/reporte.js`: PDF, generado en memoria desde la base de datos.
- `src/db.js`: Supabase (tablas `pjp_sesiones` y `pjp_solicitudes`).
- `sql/schema.sql`: crear las tablas, una sola vez.

## Rutas

- `POST /webhook`: mensajes de Twilio (verifica la firma de Twilio).
- `POST /wompi-webhook`: eventos de Wompi (verifica la firma de Wompi).
- `GET /reporte/:token.pdf`: informe pagado.

Las conversaciones y los pagos quedan en Supabase, de modo que un reinicio de Render no pierde nada. Además del aviso de Wompi, el servidor revisa cada 3 minutos los pagos pendientes.

# MT Aesthetics · Parlour OS

Programa de gestión de MT Aesthetics (agenda, clientas, cobros, inventario, finanzas, asistente).

## Variables en Railway
- `APP_PASSWORD` — contraseña para entrar (obligatoria)
- `SESSION_SECRET` — cadena larga al azar
- `DATA_DIR=/data` — con un volumen montado en `/data` para que los datos no se borren
- `ANTHROPIC_API_KEY` — opcional, activa el asistente

`npm start` arranca el servidor (Node 20+, sin dependencias).

## Reserva pública y app de la clienta
- `/reservar` — reserva abierta (servicio, día y hora, datos y salud). Usa el mismo catálogo, horario y reglas de salud que `public/app.html`.
- `/c/<enlace>` — app de la clienta (instalable en la pantalla de inicio). Cada clienta tiene un enlace personal (`clients.portalToken`), que recibe al reservar o que María le manda por WhatsApp desde su ficha.
- En la ficha de la clienta: "Enviar su app por WhatsApp", "Nota para la clienta" y "Mostrar en su app" en cada foto.
- El código está en `public-api.js`, `public/reservar.html` y `public/cliente.html`.

## Para conectar después (ya hay espacio en `public-api.js`)
- `STRIPE_SECRET_KEY` — depósito al reservar (`startDeposit`). Con la clave, las reservas quedan "esperando pago" 30 min.
- `RESEND_API_KEY` — correos de confirmación y recordatorios (`notify`).
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` — SMS (`notify`).

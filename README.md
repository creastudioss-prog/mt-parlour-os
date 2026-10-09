# MT Aesthetics · Parlour OS

Programa de gestión de MT Aesthetics (agenda, clientas, cobros, inventario, finanzas, asistente).

## Variables en Railway
- `APP_PASSWORD` — contraseña para entrar (obligatoria)
- `SESSION_SECRET` — cadena larga al azar
- `DATA_DIR=/data` — con un volumen montado en `/data` para que los datos no se borren
- `ANTHROPIC_API_KEY` — opcional, activa el asistente

`npm start` arranca el servidor (Node 20+, sin dependencias).

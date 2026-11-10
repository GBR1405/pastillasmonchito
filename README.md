# Pastillero familiar

Registro compartido de las medicinas del abuelo: quién se las dio, cómo le cayeron, síntomas y observaciones del día, con inventario y vencimientos. Funciona en el navegador del celular y se puede instalar como app (PWA).

## Qué incluye (versión 1)

- **Hoy**, con tres partes: **1 Pastillas · 2 Síntomas · 3 Observaciones**.
  - Pastillas: un horario por tarjeta (5:30–6:00 AM, 9 AM, 2 PM y 5:30 PM, ya cargados desde la hoja). Botón "Ya se las di": quién, cómo le fue (se las tomó bien / solo algunas / no quiso / las vomitó), hora y nota.
  - Línea de tiempo con una línea naranja en la hora actual. La dosis que le toca sale en azul, y se ilumina en amarillo desde 30 minutos antes hasta 30 minutos después de su hora. Arriba dice cuál le toca y cuánto falta.
  - Síntomas: casillas rápidas (mareo, náuseas, caída…), qué tan fuerte, detalles. Botón "Hoy no tuvo síntomas".
  - Observaciones: texto libre con frases rápidas.
  - Se puede navegar a días anteriores para completar registros.
- **Historial**: resumen de 7, 14 o 30 días, detalle día por día y botón para **imprimir o guardar PDF para el doctor** (incluye el esquema actual y la lista de medicinas con código y vencimiento).
- **Medicinas**: inventario (cantidad, código, vencimiento, color), editor de horarios (cambiar horas, dosis, agregar o quitar medicinas) y lista de la familia.
- El inventario se descuenta solo al registrar una toma y avisa cuando queda poco o está por vencer.
- Todos ven lo mismo: la pantalla se actualiza sola cada 20 segundos.
- **Recordatorios por notificación** en Android y iPhone: 30 minutos antes, a la hora, y si 30 minutos después nadie registró la dosis.
- **Familia fija** (opcional) con `FAMILY_MEMBERS`: nadie se agrega ni se quita desde la app.

## Probar en tu computadora

```bash
npm install
npm start
```

Abre http://localhost:3000 y entra con el código `familia`. En local usa una base SQLite en `data/` (no se sube a ningún lado).

## Publicar (Vercel + Turso)

1. **Base de datos nueva en Turso** (mejor aparte de la de otros proyectos):
   ```bash
   turso db create pastillero
   turso db show pastillero --url
   turso db tokens create pastillero
   ```
2. **Subir el proyecto a Vercel** (`vercel` desde esta carpeta, o importar el repositorio). Framework: "Other".
3. **Llaves para las notificaciones** (una sola vez, en esta carpeta):
   ```bash
   npx web-push generate-vapid-keys
   ```
4. En Vercel, **Settings → Environment Variables**, agregar:

   | Variable | Qué poner |
   |---|---|
   | `TURSO_DATABASE_URL` | la URL del paso 1 (`libsql://pastillero-…turso.io`) |
   | `TURSO_AUTH_TOKEN` | el token del paso 1 |
   | `FAMILY_CODE` | el código que toda la familia escribirá para entrar (difícil de adivinar) |
   | `FAMILY_MEMBERS` | los nombres separados por comas, por ejemplo `Gabriel, María José, Tía Ana, Luis` |
   | `VAPID_PUBLIC_KEY` | la "Public Key" del paso 3 |
   | `VAPID_PRIVATE_KEY` | la "Private Key" del paso 3 |
   | `VAPID_SUBJECT` | `mailto:` y un correo de contacto, por ejemplo `mailto:nombre@gmail.com` |
   | `CRON_SECRET` | una clave larga inventada (para la revisión automática de recordatorios) |
   | `APP_TIMEZONE` | `America/Costa_Rica` |

5. Volver a desplegar. Las tablas, el horario inicial y la lista de la familia se crean solos en el primer ingreso.
6. **Revisión automática de recordatorios.** Algo tiene que llamar a la app cada 5 minutos para que revise si toca mandar un aviso. En el plan gratis de Vercel los cron solo corren una vez al día, así que se usa [cron-job.org](https://cron-job.org) (gratis):
   - Crear un "cronjob" con la URL `https://TU-APP.vercel.app/api/cron/recordatorios`
   - Cada 5 minutos.
   - En "Advanced → Headers" agregar `Authorization` con el valor `Bearer ` + tu `CRON_SECRET` (por ejemplo `Bearer una-clave-larga`). Si el servicio no permite encabezados, se puede usar `…/api/cron/recordatorios?clave=TU_CRON_SECRET`.
   - Para probar: abrir esa dirección con `?clave=` en el navegador. Debe responder `"ok": true` y la hora de Costa Rica.

   Si tienen Vercel Pro, en vez de cron-job.org pueden agregar en `vercel.json`: `"crons": [{ "path": "/api/cron/recordatorios", "schedule": "*/5 * * * *" }]` (Vercel manda solo el `CRON_SECRET`).

## Instalar como app

- **Android (Chrome):** menú ⋮ → "Instalar aplicación".
- **iPhone (Safari):** botón Compartir → "Agregar a inicio".

## Activar los recordatorios en cada teléfono

- **Android:** en la app, tocar **Activar** en el aviso azul de "Hoy" (o en **Medicinas → Familia → Recordatorios**) y aceptar el permiso.
- **iPhone (iOS 16.4 o más):** primero agregar la app a la pantalla de inicio desde Safari, abrirla desde ese ícono y ahí tocar **Activar**. Desde Safari normal Apple no permite avisos.
- Con **Mandar aviso de prueba** se confirma que llegan.

## Primer uso

1. Entrar con el código de la familia.
2. Si no usan `FAMILY_MEMBERS`, en **Medicinas → Familia** agregar los nombres (cada quien también puede agregarse al entrar). Con `FAMILY_MEMBERS` la lista ya aparece sola.
3. En **Medicinas → Inventario**, anotar cuántas hay y el vencimiento de cada una.
4. Cada persona elige su nombre la primera vez en su teléfono.

## Notas importantes

- **Revisen el horario con la receta.** Se cargó tal como aparece en la hoja de horarios. En particular, "Nakom" quedó sin presentación y "Citicolina" como "tubo", y "Irbersartan" tal como está escrito en la hoja. Se editan en Medicinas.
- La app es un **registro**: no da consejos médicos ni cambia dosis. Los cambios los indica el doctor.
- El historial guarda lo que se dio en el momento, así que cambiar el horario después no altera los registros anteriores.
- Es información de salud: no compartan públicamente el enlace ni el código.
- Cualquiera con el código puede editar medicinas y horarios (por simplicidad en esta versión).

## Estructura

```
app.js          API (Express)
db.js           Turso/SQLite, tablas, horario inicial y familia fija
push.js         Recordatorios por notificación
server.js       Servidor local
api/index.js    Entrada para Vercel
public/         La app (HTML, CSS, JS, íconos, service worker)
```

## Ideas para la versión 2

Turnos por persona, signos vitales (presión, peso, glucosa), citas médicas, ficha de emergencia y conexión con la tablet del pastillero.

'use strict';

// Carga el archivo .env si existe (Node 20.12+)
try {
  process.loadEnvFile('.env');
} catch (_) {
  /* no hay .env, no pasa nada */
}

const createApp = require('./app');

const port = process.env.PORT || 3000;
createApp({ serveStatic: true }).listen(port, () => {
  console.log(`Pastillero familiar listo en http://localhost:${port}`);
  if (!process.env.FAMILY_CODE) {
    console.log('Aviso: no hay FAMILY_CODE; en local el código de prueba es "familia".');
  }
  if (!process.env.TURSO_DATABASE_URL) {
    console.log('Aviso: no hay TURSO_DATABASE_URL; usando base local en ./data/pastillero.db');
  }
});

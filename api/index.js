'use strict';

// Punto de entrada para Vercel (función serverless)
module.exports = require('../app')({ serveStatic: false });

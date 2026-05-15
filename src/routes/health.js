const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const dbHealth = await db.checkHealth();
  const ok = dbHealth.ok;
  const status = ok ? 200 : 503;
  
  res.status(status).json({
    ok,
    uptime: process.uptime(),
    env: process.env.NODE_ENV,
    database: dbHealth,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;

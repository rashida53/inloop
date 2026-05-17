const express = require('express');
const router = express.Router();
const db = require('../db');

// Readiness probe: checks database health. Returns 200 when ready, 503 when not.
router.get('/', async (req, res) => {
  try {
    const health = await db.checkHealth();
    if (health.ok) {
      return res.status(200).json({ ok: true, uptime: process.uptime(), database: health, timestamp: new Date().toISOString() });
    }
    return res.status(503).json({ ok: false, reason: 'database_unavailable', database: health, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(503).json({ ok: false, reason: 'health_check_failed', error: err.message });
  }
});

module.exports = router;

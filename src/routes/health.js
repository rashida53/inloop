const express = require('express');
const router = express.Router();

// Liveness probe. Lightweight and does not depend on external services.
router.get('/', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

module.exports = router;

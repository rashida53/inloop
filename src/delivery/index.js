// Delivery layer: responsible for sending messages to downstream systems
// (Slack, email, etc.)

const { deliverToSlack } = require('./slack');

module.exports = { deliverToSlack };

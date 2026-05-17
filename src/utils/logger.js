const pino = require('pino');
const { NODE_ENV, LOG_LEVEL } = process.env;
const env = NODE_ENV || 'development';

// Log level: env-aware with override via LOG_LEVEL
const level = LOG_LEVEL || (env === 'production' ? 'info' : env === 'test' ? 'silent' : 'debug');

// Redact common secret paths
const redact = {
	paths: [
		'req.headers.authorization',
		'req.headers.Authorization',
		'*.token',
		'*.api_key',
		'*.apiKey',
		'*.password',
		'*.secret',
		'*.client_secret',
	],
	remove: true,
};

const base = { service: 'inloop', env };

let logger;
if (env === 'development') {
	// Use pino-pretty in development when available for readable output
	try {
		const transport = pino.transport({
			target: 'pino-pretty',
			options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
		});
		logger = pino({ level, redact, base, transport });
	} catch (err) {
		// Fallback if pino.transport or pino-pretty is unavailable
		logger = pino({ level, redact, base });
	}
} else {
	logger = pino({ level, redact, base });
}

module.exports = logger;

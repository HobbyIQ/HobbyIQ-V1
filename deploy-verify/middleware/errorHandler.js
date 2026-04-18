const { logger } = require('../utils/logger');

module.exports = (err, req, res, next) => {
  logger.error(err.stack || err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
};

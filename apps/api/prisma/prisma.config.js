const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  datasource: {
    db: {
      provider: 'postgresql',
      url: 'postgresql://postgres:password@localhost:5432/hobbyiq',
    },
  },
});

# HobbyIQ Learning System - Install Instructions

# 1. Install dependencies (from the root of your monorepo or apps/api):
npm install dotenv
npm install @azure/ai-text-analytics @azure/ai-form-recognizer @azure/ai-openai @azure/search-documents @azure/storage-blob @azure/monitor-query @azure/monitor-opentelemetry-exporter ioredis

# 2. (Optional) For type safety and future Azure SDKs:
npm install --save-dev @types/node

# 3. (Optional) For local development with nodemon:
npm install --save-dev nodemon

# 4. (Optional) For Prisma/Postgres later:
npm install @prisma/client
npm install --save-dev prisma

# 5. (Optional) For linting:
npm install --save-dev eslint

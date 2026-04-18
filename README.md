# HobbyIQ Backend

## Local Development

1. Install dependencies:
   npm install
2. Run in development mode (with auto-reload):
   npx ts-node-dev src/server.ts
3. Run tests:
   npm test

## Build for Production

1. Compile TypeScript:
   npm run build
   (Outputs to dist/)
2. Start production server locally:
   npm start

## Azure App Service Deployment

- Only the compiled output in dist/, package.json, and package-lock.json are deployed.
- Azure runs: node dist/server.js
- The server must bind to process.env.PORT (default 8080) and 0.0.0.0
- Health endpoint: GET /api/health
- No build or TypeScript source is required at runtime.

## Project Structure

- src/         # TypeScript source
- dist/        # Compiled output (never committed)
- package.json
- package-lock.json
- .gitignore
- .deployment  # Azure build settings (if present)

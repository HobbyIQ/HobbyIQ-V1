import request from 'supertest';
import express from 'express';
import diagnosticsRouter from '../../admin/diagnostics/diagnostics.controller';

describe('DiagnosticsController', () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/diagnostics', diagnosticsRouter);

  it('should return diagnostics overview', async () => {
    const res = await request(app).get('/admin/diagnostics/overview');
    expect(res.status).toBe(200);
    expect(res.body.providers).toBeDefined();
  });
});

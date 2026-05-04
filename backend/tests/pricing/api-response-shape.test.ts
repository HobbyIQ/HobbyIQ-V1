import request from 'supertest';
import { expect } from 'chai';
let app: any;
before(async () => {
  app = (await import('../../src/server.js')).default || (await import('../../src/server.js'));
});

describe('/api/compiq/query', () => {
  it('returns stable output shape', async () => {
    const res = await request(app)
      .post('/api/compiq/query')
      .send({ subject: { id: 't', name: 'T', set: 'S', year: 2020 }, comps: [], context: { marketIndexTrend: 'flat', volatilityIndex: 50 } });
    expect(res.body).to.have.property('priceLanes');
    expect(res.body).to.have.property('observability');
  });
});

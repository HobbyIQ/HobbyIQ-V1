

import request from 'supertest';
import { expect } from 'chai';
let app: any;
before(async () => {
  app = (await import('../../src/server.js')).default || (await import('../../src/server.js'));
});

describe('/api/compiq/estimate', () => {
  it('returns stable output shape', async () => {
    const res = await request(app)
      .post('/api/compiq/estimate')
      .send({ subject: { playerName: 'T', setName: 'S', cardYear: 2020 }, comps: [], context: { marketIndexTrend: 0, volatilityIndex: 50 } });
    expect(res.body).to.have.property('priceLanes');
    expect(res.body).to.have.property('observability');
    expect(res.body).to.have.property('verdict');
    expect(res.body).to.have.property('explanationBullets');
  });
});

"use strict";
const request = require('supertest');
const { expect } = require('chai');
const { strongBuyPayload, holdPayload, sellPayload, passPayload, sparseCompsPayload } = require('./compiq-estimate.fixtures');
let app;
before(() => {
    app = require('../../src/server');
    if (app && app.default)
        app = app.default;
});
describe('/api/compiq/estimate', () => {
    it('returns strong buy verdict and price lanes', async () => {
        const res = await request(app).post('/api/compiq/estimate').send(strongBuyPayload);
        expect(res.body).to.have.property('verdict');
        expect(res.body.verdict.toLowerCase()).to.contain('strong buy');
        expect(res.body.dealScore).to.be.at.least(90);
        expect(res.body).to.have.property('priceLanes');
        expect(res.body.priceLanes.fairMarketValue).to.be.greaterThan(0);
        expect(res.body.explanationBullets.length).to.be.at.least(3);
    });
    it('returns hold verdict and price lanes', async () => {
        const res = await request(app).post('/api/compiq/estimate').send(holdPayload);
        expect(res.body).to.have.property('verdict');
        expect(res.body.verdict.toLowerCase()).to.contain('hold');
        expect(res.body.dealScore).to.be.at.least(60);
        expect(res.body.dealScore).to.be.lessThan(75);
        expect(res.body.priceLanes.fairMarketValue).to.be.greaterThan(0);
    });
    it('returns sell verdict and price lanes', async () => {
        const res = await request(app).post('/api/compiq/estimate').send(sellPayload);
        expect(res.body).to.have.property('verdict');
        expect(res.body.verdict.toLowerCase()).to.contain('sell');
        expect(res.body.dealScore).to.be.lessThan(60);
        expect(res.body.priceLanes.fairMarketValue).to.be.greaterThan(0);
    });
    it('returns pass verdict and price lanes', async () => {
        const res = await request(app).post('/api/compiq/estimate').send(passPayload);
        expect(res.body).to.have.property('verdict');
        expect(res.body.verdict.toLowerCase()).to.contain('pass');
        expect(res.body.dealScore).to.be.lessThan(45);
        expect(res.body.priceLanes.fairMarketValue).to.be.greaterThan(0);
    });
    it('returns fallback for sparse comps', async () => {
        const res = await request(app).post('/api/compiq/estimate').send(sparseCompsPayload);
        console.log('FALLBACK RESPONSE:', JSON.stringify(res.body, null, 2));
        expect(res.body).to.have.property('observability');
        expect(res.body.observability.usedFallback).to.be.true;
        expect(res.body.priceLanes.fairMarketValue).to.equal(0);
        expect(res.body.explanation).to.include('Insufficient data for pricing');
    });
});

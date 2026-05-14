const { CosmosClient } = require('@azure/cosmos');
(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) throw new Error('COSMOS_CONNECTION_STRING not set');
  const client = new CosmosClient(conn);
  const c = client.database('hobbyiq').container('compiq_predictions');
  const { resources } = await c.items.query({
    query: "SELECT TOP 5 c.player, c['set'] as setName, c.cardNumber, c.predicted72h, c.predicted7d, c.direction, c.confidence, c.recommendation, c.source, c['timestamp'] as ts FROM c WHERE c.player = @p ORDER BY c['timestamp'] DESC",
    parameters: [{ name: '@p', value: process.argv[2] || 'Caleb Bonemer' }]
  }).fetchAll();
  console.log(JSON.stringify(resources, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });

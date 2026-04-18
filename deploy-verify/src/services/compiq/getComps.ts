export async function getComps(payload: any) {
  // Mock: return fake comps
  return [
    { date: '2026-04-10', price: 385, grade: 'raw', source: 'eBay', notes: 'clean comp' },
    { date: '2026-04-08', price: 392, grade: 'raw', source: 'eBay', notes: '' },
    { date: '2026-04-05', price: 365, grade: 'raw', source: 'eBay', notes: '' },
    { date: '2026-03-28', price: 415, grade: 'raw', source: 'eBay', notes: '' },
    { date: '2026-03-20', price: 370, grade: 'raw', source: 'eBay', notes: '' },
    { date: '2026-03-10', price: 400, grade: 'raw', source: 'eBay', notes: '' },
  ];
}

// Privremena memorijska baza. Zamjenjuje se pravom bazom (npr. PostgreSQL).
export function createStore(seed = []) {
  const docs = new Map(seed.map((d) => [d.id, { ...d }]));
  return {
    get: (id) => docs.get(id) ?? null,
    put: (doc) => { docs.set(doc.id, { ...doc }); return docs.get(doc.id); },
    listFor: (userId) => [...docs.values()].filter((d) => d.ownerId === userId),
  };
}

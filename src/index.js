import { createApp } from './app.js';
import { createStore } from './store.js';

const store = createStore([
  { id: 'demo-1', ownerId: 'ana@fpzg.hr', title: 'Seminar', content: '' },
]);
const port = Number(process.env.PORT ?? 4000);
createApp({ store }).listen(port, () => console.log(`Ductura server na http://localhost:${port}`));

import { createApp } from "./app.ts";
import { createStore } from "./store.ts";

const store = createStore([
  { id: "demo-1", ownerId: "student-a@primjer.invalid", title: "Seminar", content: "" },
]);
const port = Number(process.env.PORT ?? 4000);
createApp({ store }).listen(port, () => {
  console.log(`Ductura server na http://localhost:${port}`);
});

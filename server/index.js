import 'dotenv/config';
import { ensureConfig } from './configService.js';
import { buildApp } from './app.js';

ensureConfig();
const app = buildApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RACKSTACK server listening on :${PORT}`);
});

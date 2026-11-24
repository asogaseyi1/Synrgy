import { config } from './config.ts';
import { createApp } from './app.ts';

createApp().listen(config.port, () => {
  console.log(`Synrgy API listening on http://localhost:${config.port}`);
});

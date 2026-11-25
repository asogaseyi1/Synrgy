import { config } from './config.ts';
import { createApp } from './app.ts';
import { startJobs } from './lib/jobs.ts';

createApp().listen(config.port, () => {
  console.log(`Synrgy API listening on http://localhost:${config.port}`);
  console.log(`Email provider: ${config.mailProvider}${config.mailProvider === 'none' ? ' (set MAIL_PROVIDER to send email)' : ''}`);
  startJobs();
});

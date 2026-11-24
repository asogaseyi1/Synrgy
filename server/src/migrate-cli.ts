import { migrate } from './migrate.ts';

try {
  await migrate();
  console.log('migrations up to date');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

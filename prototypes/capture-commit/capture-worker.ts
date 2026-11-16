import { acquireLease, commitPage, createJob, openStore, readJob, type CrashPoint } from './store.ts';
import { ACCOUNT, COLLECTION, pageAt } from './feed.ts';

const [dbPath, owner, nowArg, crashPageArg, crashPointArg] = process.argv.slice(2);
const now = Number(nowArg);
const crashPage = crashPageArg === undefined ? -1 : Number(crashPageArg);
const crashPoint = crashPointArg as CrashPoint | undefined;

const db = openStore(dbPath);
createJob(db, 'job-1', ACCOUNT, COLLECTION);
if (!acquireLease(db, 'job-1', owner, now, 60_000)) {
  console.error('lease held by another owner');
  process.exit(3);
}

for (;;) {
  const job = readJob(db, 'job-1');
  if (job.finished) break;
  const page = pageAt(job.started ? job.cursor : null);
  commitPage(db, 'job-1', owner, now, page, job.pagesCommitted === crashPage ? crashPoint : undefined);
}
db.close();

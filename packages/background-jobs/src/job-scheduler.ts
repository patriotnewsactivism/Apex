import { CronParser } from '@workspace/cron-parser';
import { db, scheduledJobs, tasks } from '@workspace/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JobExecutor } from '@workspace/executor';
import { 
  ACTOR_HEADER, 
  resolveCancelActor, 
  validateCancelReason, 
  cancelAttestationError,
  buildCancellationUpdate
} from '@workspace/api-server/src/routes/cancel-attribution';
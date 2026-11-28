import { z } from 'zod';
import { JobStatusSchema, JobSummarySchema, JobViewSchema, WaitingByProviderSchema } from './jobs';
import { PageRequestSchema, pageOf } from './paging';
import { ModelNameSchema, ProviderIdSchema } from './provider-ref';
import { type ChannelContracts, ChosenIdsSchema, EmptyRequestSchema, IdSchema } from './ipc-shared';

/** The job channels: the job list and summary, cancel, retry, resume and moving waiting jobs to another provider. */
export const jobChannels = {
  /** Newest first. */
  'jobs:list': {
    request: PageRequestSchema.extend({
      status: JobStatusSchema.optional(),
      providerId: ProviderIdSchema.optional(),
      ids: ChosenIdsSchema.optional(),
    }),
    response: pageOf(JobViewSchema),
  },
  'jobs:summary': {
    request: EmptyRequestSchema,
    response: JobSummarySchema,
  },
  /** A finished job is left alone. */
  'jobs:cancel': {
    request: z.object({ jobId: IdSchema }),
    response: z.object({}),
  },
  /** Every queued, waiting and running job. */
  'jobs:cancelAll': {
    request: EmptyRequestSchema,
    response: z.object({ cancelled: z.number().int().nonnegative() }),
  },
  /** `invalid_operation` unless the job is failed or cancelled and its file has no active job. */
  'jobs:retry': {
    request: z.object({ jobId: IdSchema }),
    response: z.object({}),
  },
  /** Every failed or cancelled job whose file has no active job. */
  'jobs:retryFailed': {
    request: EmptyRequestSchema,
    response: z.object({ retried: z.number().int().nonnegative() }),
  },
  /** Waiting analysis jobs per provider; `providerId` null is the jobs without one. */
  'jobs:waitingByProvider': {
    request: EmptyRequestSchema,
    response: z.array(WaitingByProviderSchema),
  },
  /** Ends the pause of one provider's analysis queue; `null` is the jobs without a provider. */
  'jobs:resume': {
    request: z.object({ providerId: ProviderIdSchema.nullable() }),
    response: z.object({}),
  },
  /** Ends the pause of one download host. */
  'jobs:resumeHost': {
    request: z.object({ host: z.string().min(1).max(300) }),
    response: z.object({}),
  },
  /** Moves every waiting analysis job of one provider onto another with this model; a running job stays. */
  'jobs:reroute': {
    request: z.object({
      fromProviderId: ProviderIdSchema.nullable(),
      toProviderId: ProviderIdSchema,
      model: ModelNameSchema,
    }),
    response: z.object({ moved: z.number().int().min(0) }),
  },
  /** Deletes every succeeded, failed and cancelled job. */
  'jobs:clearFinished': {
    request: EmptyRequestSchema,
    response: z.object({ removed: z.number().int().nonnegative() }),
  },
} as const satisfies ChannelContracts;

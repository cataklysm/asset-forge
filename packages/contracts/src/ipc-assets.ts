import { z } from 'zod';
import { AssetListFilterSchema } from './analysis';
import {
  AssetDetailSchema,
  AssetListSchema,
  AssetRelationSchema,
  AssetRelationViewSchema,
  AssetSchema,
  AssetStatusSchema,
  AssetTypeSchema,
  DescriptionInputSchema,
  NameInputSchema,
  RelationKindSchema,
  SetCoverRequestSchema,
} from './library';
import { PageRequestSchema } from './paging';
import { type ChannelContracts, EmptyRequestSchema, IdRequestSchema, IdSchema } from './ipc-shared';

const RelationKeySchema = z.object({
  fromAssetId: IdSchema,
  toAssetId: IdSchema,
  kind: RelationKindSchema,
});

export const assetChannels = {
  'assetTypes:list': {
    request: EmptyRequestSchema,
    response: z.array(AssetTypeSchema),
  },
  'assets:list': {
    request: PageRequestSchema.extend(AssetListFilterSchema.shape),
    response: AssetListSchema,
  },
  'assets:get': {
    request: IdRequestSchema,
    response: AssetDetailSchema,
  },
  'assets:create': {
    request: z.object({
      name: NameInputSchema,
      typeId: IdSchema,
      description: DescriptionInputSchema.optional(),
    }),
    response: AssetSchema,
  },
  'assets:update': {
    request: z.object({
      id: IdSchema,
      patch: z
        .object({
          name: NameInputSchema.optional(),
          description: DescriptionInputSchema.optional(),
          typeId: IdSchema.optional(),
          status: AssetStatusSchema.optional(),
        })
        .strict(),
    }),
    response: AssetDetailSchema,
  },
  'assets:setCover': {
    request: SetCoverRequestSchema,
    response: AssetDetailSchema,
  },
  'assets:addTag': {
    request: z.object({ assetId: IdSchema, name: z.string().max(200) }),
    response: AssetDetailSchema,
  },
  'assets:removeTag': {
    request: z.object({ assetId: IdSchema, name: z.string().max(200) }),
    response: AssetDetailSchema,
  },
  'assets:addSource': {
    request: z.object({ assetId: IdSchema, url: z.string().max(2000) }),
    response: AssetDetailSchema,
  },
  'assets:removeSource': {
    request: z.object({ assetId: IdSchema, sourceId: IdSchema }),
    response: AssetDetailSchema,
  },
  // Opens a stored source in the system browser; the renderer never passes the address itself.
  'assets:openSource': {
    request: z.object({ assetId: IdSchema, sourceId: IdSchema }),
    response: z.null(),
  },
  'relations:list': {
    request: z.object({ assetId: IdSchema }),
    response: z.array(AssetRelationViewSchema),
  },
  'relations:add': {
    request: RelationKeySchema,
    response: AssetRelationSchema,
  },
  'relations:remove': {
    request: RelationKeySchema,
    response: z.null(),
  },
} as const satisfies ChannelContracts;

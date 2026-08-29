/** Zod request/response schemas. Every inbound payload is parsed through these. */
import { z } from 'zod';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH } from './constants';
import { DOCUMENT_CLASSIFICATIONS, ROLES } from './types';

export const roleSchema = z.enum(ROLES);
export const classificationSchema = z.enum(DOCUMENT_CLASSIFICATIONS);

export const queryRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(MIN_QUERY_LENGTH, `Query must be at least ${MIN_QUERY_LENGTH} characters.`)
      .max(MAX_QUERY_LENGTH, `Query must be at most ${MAX_QUERY_LENGTH} characters.`),
    conversation_id: z.string().uuid().optional(),
    drill_down: z.boolean().optional(),
  })
  .strict();

export const feedbackRequestSchema = z
  .object({
    turn_id: z.string().uuid(),
    feedback: z.enum(['up', 'down']),
  })
  .strict();

export const reindexRequestSchema = z
  .object({
    document_ids: z.array(z.string().min(1)).max(500).optional(),
    classification: classificationSchema.optional(),
    full: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.full) || Boolean(v.document_ids?.length) || Boolean(v.classification),
    { message: 'Specify document_ids, classification, or full: true.' },
  );

export const usageQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    role: roleSchema.optional(),
  })
  .strict();

/**
 * SharePoint change notification payload.
 * Note: SharePoint first performs a handshake by calling the endpoint with a
 * `validationtoken` query parameter and no body; that path is handled before
 * this schema is applied.
 */
export const sharePointNotificationSchema = z
  .object({
    value: z
      .array(
        z.object({
          subscriptionId: z.string(),
          clientState: z.string().optional(),
          resource: z.string(),
          tenantId: z.string().optional(),
          siteUrl: z.string().optional(),
          webId: z.string().optional(),
          expirationDateTime: z.string().optional(),
        }),
      )
      .max(100),
  })
  .passthrough();

export const documentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Document id contains unsupported characters.');

export type QueryRequestInput = z.infer<typeof queryRequestSchema>;
export type ReindexRequestInput = z.infer<typeof reindexRequestSchema>;
export type UsageQueryInput = z.infer<typeof usageQuerySchema>;
export type SharePointNotification = z.infer<typeof sharePointNotificationSchema>;

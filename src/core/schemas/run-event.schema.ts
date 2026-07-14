import { z } from "zod";

export const RunEventSchema = z.object({
  at: z.string().datetime({ offset: true }),
  type: z.enum(["status", "classification", "transition", "receipt", "gate", "stop"]),
  workId: z.string().optional(),
  inboxId: z.string().optional(),
  state: z.string().optional(),
  message: z.string().min(1),
  nextAction: z.string().optional(),
}).strict();

const { z } = require("zod");

const ExecutorSchema = z.object({
  implementationSummary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      purpose: z.string(),
      content: z.string(),
    })
  ),
  environmentVariables: z.array(z.string()),
  databaseSchema: z.string().nullable(),
  installCommand: z.string().nullable(),
  startCommand: z.string().nullable(),
  port: z.number().nullable(),
  buildTasks: z.array(
    z.object({
      order: z.number(),
      task: z.string(),
      details: z.string(),
    })
  ),
});

const AuditorSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium"]),
      rule: z.string(),
      file: z.string().nullable(),
      description: z.string(),
      fix: z.string(),
    })
  ),
  summary: z.string(),
  planDeviationDetected: z.boolean().optional().default(false),
  planDeviationNote: z.string().nullable().optional().default(null),
});

module.exports = {
  ExecutorSchema,
  AuditorSchema,
};
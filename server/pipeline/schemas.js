const { z } = require("zod");

const PlannerSchema = z.object({
  projectName: z.string(),
  template: z.enum([
    "fullstack-internal-tool",
    "api-service",
    "admin-ops-tool",
    "integration-worker",
  ]),
  modules: z.array(z.string()),
  database: z.object({
    required: z.boolean(),
    tables: z.array(
      z.object({
        name: z.string(),
        purpose: z.string(),
      })
    ),
  }),
  environmentVariables: z.array(z.string()),
  apiEndpoints: z.array(
    z.object({
      method: z.string(),
      route: z.string(),
      purpose: z.string(),
    })
  ),
  uiPages: z.array(
    z.object({
      route: z.string(),
      purpose: z.string(),
    })
  ),
  backgroundWorkers: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
    })
  ),
  dataFlows: z.array(z.string()),
  risks: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});

const ReviewerSchema = z.object({
  approved: z.boolean(),
  withRequiredChanges: z.array(
    z.object({
      issue: z.string(),
      whyItMatters: z.string(),
      requiredFix: z.string(),
    })
  ),
  riskLevel: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  architecturalConcerns: z.array(z.string()),
  securityConcerns: z.array(z.string()),
  overengineeringConcerns: z.array(z.string()),
});

const PolicyGateSchema = z.object({
  autoApprove: z.boolean(),
  humanApprovalRequired: z.boolean(),
  reason: z.string(),
});

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

module.exports = {
  PlannerSchema,
  ReviewerSchema,
  PolicyGateSchema,
  ExecutorSchema,
};

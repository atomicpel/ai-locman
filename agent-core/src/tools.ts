import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ToolContext = { userId: string; projectId: string; taskId: string };
export type ToolDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  input: T;
  risk: "read" | "write" | "dangerous";
  execute: (input: z.infer<T>, context: ToolContext) => Promise<unknown>;
};

const registry = new Map<string, ToolDefinition>();

export function registerTool<T extends z.ZodTypeAny>(tool: ToolDefinition<T>) {
  if (registry.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
  registry.set(tool.name, tool as unknown as ToolDefinition);
}

export function getTool(name: string) {
  return registry.get(name);
}

export function listTools() {
  return [...registry.values()].map(({ name, description, input, risk }) => ({
    name, description, input: zodToJsonSchema(input), risk
  }));
}

// No shell/GitHub tool is enabled until sandbox and approval policies are implemented.

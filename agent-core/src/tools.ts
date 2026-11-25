import { z } from "zod";

export type ToolContext = { userId: string; projectId: string; taskId: string };
export type ToolDefinition<T extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  input: T;
  risk: "read" | "write" | "dangerous";
  execute: (input: z.infer<T>, context: ToolContext) => Promise<unknown>;
};

const registry = new Map<string, ToolDefinition>();

export function registerTool<T extends z.ZodType>(tool: ToolDefinition<T>) {
  if (registry.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
  registry.set(tool.name, tool as unknown as ToolDefinition);
}

export function getTool(name: string) {
  return registry.get(name);
}

export function listTools() {
  return [...registry.values()].map(({ name, description, input, risk }) => ({
    name, description, input: z.toJSONSchema(input), risk
  }));
}

// No shell/GitHub tool is enabled until sandbox and approval policies are implemented.

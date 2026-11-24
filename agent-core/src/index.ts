import "dotenv/config";
import { chatCompletion } from "./openrouter.js";
import { listTools } from "./tools.js";

async function main() {
  console.log("AI Locman Agent Core scaffold started.");
  console.log("Registered tools:", listTools().length);
  if (process.env.OPENROUTER_API_KEY && process.env.TEST_MODEL) {
    const result: any = await chatCompletion(process.env.TEST_MODEL, [
      { role: "user", content: "Ответь одним словом: готов." }
    ]);
    console.log(result.choices?.[0]?.message?.content ?? "No content");
  } else {
    console.log("Set OPENROUTER_API_KEY and TEST_MODEL to run a provider smoke test.");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

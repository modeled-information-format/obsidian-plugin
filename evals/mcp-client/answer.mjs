// A Claude Code "Elicitation" hook that answers as the user would, for a case that
// says how. The runner passes the answer in MIF_EVAL_ANSWER (the form's content,
// or "decline") and collects what was asked in the file named by MIF_EVAL_ASKED,
// so the case can check the question as well as the outcome.

import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let asked = {};
try {
  asked = JSON.parse(input);
} catch {
  asked = { unparsed: input.slice(0, 500) };
}
if (process.env.MIF_EVAL_ASKED) appendFileSync(process.env.MIF_EVAL_ASKED, JSON.stringify({ server: asked.mcp_server_name, message: asked.message, mode: asked.mode, schema: asked.requested_schema }) + "\n");

const answer = JSON.parse(process.env.MIF_EVAL_ANSWER ?? '"decline"');
const out = answer === "decline" ? { hookEventName: "Elicitation", action: "decline" } : { hookEventName: "Elicitation", action: "accept", content: answer };
process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));

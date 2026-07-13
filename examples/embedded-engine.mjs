// Build first: npm run build
import { VanguardEngine } from "../dist/src/index.js";

const workspace = process.argv[2] ?? process.cwd();
const engine = new VanguardEngine({
  logger: (line) => process.stderr.write(`${line}\n`),
});

const unsubscribe = engine.subscribe(({ sessionId, cursor, event }) => {
  process.stdout.write(`[${sessionId} #${cursor}] ${event.type}: ${event.message ?? event.detail ?? event.title}\n`);
});

try {
  const session = await engine.create({
    workspace,
    provider: process.env.VANGUARD_PROVIDER ?? "deepseek",
    model: process.env.VANGUARD_MODEL ?? "deepseek-v4-pro",
    // Omit verification when Vanguard can detect npm/pytest/Gradle/Cargo.
  });
  engine.advance(session.sessionId, "Inspect this repository and explain what it does. Do not modify files.");
  while (engine.status(session.sessionId).state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  unsubscribe();
  await engine.shutdown();
}

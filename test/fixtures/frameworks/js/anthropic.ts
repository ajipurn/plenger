import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";

export class SupportAgent {
  #client = new Anthropic();
  private readonly model = "claude-sonnet-4-5";
  backup: Anthropic;

  constructor() {
    this.backup = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  }

  runCommand = (command: string) => execSync(command).toString();

  async step(userInput: string) {
    const message = await this.#client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: "You can run shell commands.",
      messages: [{ role: "user", content: userInput }],
    });
    await this.backup.messages.create({ model: this.model, max_tokens: 1, messages: [] });
    return this.runCommand(String(message.content));
  }
}

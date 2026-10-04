import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";

export function Welcome({ onScan, available }: { onScan: () => void; available: boolean }) {
  return (
    <div className="welcome-layout">
      <section className="welcome-panel">
        <div className="welcome-art welcome-emblem" aria-hidden="true">
          <Icon name="redteam" />
        </div>
        <p className="eyebrow">Start with the source</p>
        <h2>
          Know your agent.
          <br />
          See its reach.
        </h2>
        <p className="welcome-description">
          Scan your project to map its models, tools, and entry points — and see the code paths that
          deserve a closer look.
        </p>
        <Button
          type="button"
          className="button button-primary"
          disabled={!available}
          onClick={onScan}
        >
          <Icon name="scan" />
          Scan this project
        </Button>
        <div className="welcome-note">
          <Icon name="check" />
          No project setup or API key required
        </div>
      </section>
      <section className="getting-started">
        <p className="eyebrow">Three steps to a clearer picture</p>
        <h2>Your review workflow</h2>
        <ol className="workflow-list">
          <li>
            <span className="step-number">01</span>
            <div>
              <h3>Map the agent</h3>
              <p>Find models, tools, routes, and the capabilities connected to them.</p>
            </div>
          </li>
          <li>
            <span className="step-number">02</span>
            <div>
              <h3>Review the findings</h3>
              <p>Prioritize by severity and confidence, then inspect the source evidence.</p>
            </div>
          </li>
          <li>
            <span className="step-number">03</span>
            <div>
              <h3>Prepare for red-teaming</h3>
              <p>Review discovered llmfy targets and preparation gaps.</p>
              <span className="tag">Preparation preview</span>
            </div>
          </li>
        </ol>
        <div className="quiet-note">
          <Icon name="redteam" />
          <p>
            Python, JavaScript, and TypeScript source. Your project code is never executed during
            analysis.
          </p>
        </div>
      </section>
    </div>
  );
}

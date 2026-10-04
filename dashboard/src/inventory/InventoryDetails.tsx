import { Icon } from "../shared/icons.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import type { InventoryItem } from "./inventory-items.ts";

export function InventoryDetails({ item }: { item: InventoryItem }) {
  const capabilities = uniqueObservations(item.capabilities ?? []);
  return (
    <div className="stack inventory-item-content">
      <div className="inventory-detail-source">
        <Icon name="source-files" />
        <code>
          {item.location.path}:{item.location.line}:{item.location.column}
        </code>
      </div>
      {item.description && <p>{item.description}</p>}
      <dl className="detail-list">
        {item.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {item.prompt !== undefined && (
        <div>
          <h4>Captured prompt</h4>
          <pre className="code-block">
            <code>{item.prompt}</code>
          </pre>
        </div>
      )}
      {item.capabilities && (
        <div>
          <h4>Observed capabilities</h4>
          {capabilities.length === 0 ? (
            <p className="muted">No capabilities observed in this scope.</p>
          ) : (
            <ul className="evidence-list">
              {capabilities.map((capability) => (
                <li key={JSON.stringify(capability)}>
                  <div className="capability-heading">
                    <span className="tag">{capability.kind.replaceAll("_", " ")}</span>
                    <code>{capability.target}</code>
                    {capability.hosted && <span className="tag">Provider hosted</span>}
                  </div>
                  <div className="capability-location">
                    <code>
                      {capability.location.path}:{capability.location.line}
                    </code>
                  </div>
                  {!!capability.guards?.length && (
                    <p className="muted capability-guards">
                      Observed checks: {capability.guards.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

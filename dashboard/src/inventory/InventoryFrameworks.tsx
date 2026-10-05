import type { Inventory } from "../../../src/inventory/model.ts";
import { EmptyState } from "../shared/EmptyState.tsx";
import { plural } from "../shared/format.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";

function Files({ files }: { files: string[] }) {
  return (
    <>
      <span className="inventory-file-count">
        {files.length} {plural(files.length, "file")}
      </span>
      {files[0] && (
        <code className="inventory-source-directory" title={files.join("\n")}>
          {files[0]}
          {files.length > 1 && ` +${files.length - 1} more`}
        </code>
      )}
    </>
  );
}

export function InventoryFrameworks({
  frameworks,
  unrecognised,
}: {
  frameworks: Inventory["frameworks"];
  unrecognised: Inventory["unrecognised"];
}) {
  return (
    <div className="inventory-category">
      <div className="subnav-content-heading">
        <div>
          <h2>
            Frameworks{" "}
            <span className="tag">
              <MorphNumber value={frameworks.length} />
            </span>
          </h2>
          <p className="muted">Supported AI frameworks observed in source.</p>
        </div>
      </div>
      <div className="panel inventory-panel">
        {frameworks.length === 0 ? (
          <EmptyState
            className="inventory-empty"
            icon="frameworks"
            iconClassName="inventory-empty-symbol"
            title="No frameworks observed"
            titleLevel="h3"
            description="None of the supported AI frameworks appear in the scanned source files."
            descriptionClassName="muted"
          />
        ) : (
          <table className="inventory-table inventory-framework-table">
            <caption className="sr-only">Frameworks observed in source</caption>
            <thead>
              <tr>
                <th scope="col">Framework</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {frameworks.map((framework) => (
                <tr key={framework.id}>
                  <td>
                    <span className="inventory-name-content">
                      <span className="inventory-item-name">{framework.name}</span>
                      <span className="inventory-framework">{framework.id}</span>
                    </span>
                  </td>
                  <td>
                    <Files files={framework.files} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="inventory-table-controls">
          <p className="count-label">
            <MorphNumber value={frameworks.length} /> {plural(frameworks.length, "framework")}
          </p>
        </div>
      </div>
      {unrecognised.length > 0 && (
        <>
          <div className="subnav-content-heading inventory-secondary-heading">
            <div>
              <h3>
                Unrecognized AI imports{" "}
                <span className="tag">
                  <MorphNumber value={unrecognised.length} />
                </span>
              </h3>
              <p className="muted">
                AI libraries imported without a detector. Their usage is not analyzed.
              </p>
            </div>
          </div>
          <div className="panel inventory-panel">
            <table className="inventory-table inventory-framework-table">
              <caption className="sr-only">Unrecognized AI imports</caption>
              <thead>
                <tr>
                  <th scope="col">Module</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {unrecognised.map((item) => (
                  <tr key={item.module}>
                    <td>
                      <span className="inventory-name-content">
                        <code className="inventory-item-name" title={item.module}>
                          {item.module}
                        </code>
                      </span>
                    </td>
                    <td>
                      <Files files={item.files} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

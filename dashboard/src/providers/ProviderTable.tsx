import { Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import { EmptyState } from "../shared/EmptyState.tsx";
import { Icon } from "../shared/icons.tsx";
import { PROVIDER_LABELS } from "../shared/providers.ts";
import { SearchField } from "../shared/SearchField.tsx";
import { Button } from "../shared/ui.tsx";

export function ProviderTable({
  id,
  providers,
  query,
  onQueryChange,
  busy,
  onEdit,
  onTest,
  onMakeDefault,
  onDelete,
}: {
  id: string;
  providers: SavedProvider[];
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  onEdit: (provider: SavedProvider, trigger: HTMLButtonElement) => void;
  onTest: (provider: SavedProvider) => void;
  onMakeDefault: (provider: SavedProvider) => void;
  onDelete: (provider: SavedProvider) => void;
}) {
  const visibleProviders = providers.filter((item) =>
    [item.name, item.provider, item.model, item.baseUrl]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="providers-toolbar">
        <SearchField
          id={`${id}-search`}
          label="Search providers"
          placeholder="Search providers…"
          value={query}
          onChange={onQueryChange}
        />
      </div>
      <div className="panel providers-table-panel">
        <table className="providers-table">
          <caption className="sr-only">Saved providers available for security scans</caption>
          <colgroup>
            <col className="provider-name-column" />
            <col className="provider-model-column" />
            <col className="provider-endpoint-column" />
            <col className="provider-actions-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Provider / model</th>
              <th scope="col">Endpoint</th>
              <th scope="col" className="provider-actions-cell">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleProviders.map((item) => (
              <tr key={item.id}>
                <td className="provider-name-cell">
                  <Button
                    className="provider-name-button"
                    disabled={busy}
                    onClick={(event) => onEdit(item, event.currentTarget)}
                  >
                    {item.name}
                  </Button>
                  {item.isDefault && <span className="tag provider-default-tag">Default</span>}
                  <span className="provider-mobile-endpoint" title={item.baseUrl}>
                    {item.baseUrl}
                  </span>
                </td>
                <td className="provider-model-cell">
                  <span>{PROVIDER_LABELS[item.provider]}</span>
                  <code title={item.model}>{item.model}</code>
                </td>
                <td className="provider-endpoint-cell">
                  <span title={item.baseUrl}>{item.baseUrl}</span>
                  <span className="muted">
                    {item.provider === "chatgpt"
                      ? item.chatgptAccount
                        ? `ChatGPT: ${item.chatgptAccount}`
                        : "ChatGPT sign-in needed"
                      : item.hasApiKey
                        ? "API key saved"
                        : item.provider === "ollama"
                          ? "No API key"
                          : "API key missing"}
                  </span>
                </td>
                <td className="provider-actions-cell">
                  <div className="provider-row-actions">
                    <Button
                      className="button button-secondary"
                      aria-label={`Edit ${item.name}`}
                      disabled={busy}
                      onClick={(event) => onEdit(item, event.currentTarget)}
                    >
                      <Icon name="edit" /> <span>Edit</span>
                    </Button>
                    <MenuTrigger>
                      <Button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Actions for ${item.name}`}
                      >
                        …
                      </Button>
                      <Popover
                        className="provider-action-menu ui-popover"
                        placement="bottom end"
                        offset={6}
                      >
                        <Menu aria-label={`Actions for ${item.name}`}>
                          <MenuItem
                            textValue="Test connection"
                            className="provider-menu-item"
                            onAction={() => onTest(item)}
                          >
                            <Icon name="providers" /> Test connection
                          </MenuItem>
                          <MenuItem
                            textValue="Make default"
                            className="provider-menu-item"
                            isDisabled={item.isDefault}
                            onAction={() => onMakeDefault(item)}
                          >
                            <Icon name="check" /> Make default
                          </MenuItem>
                          <MenuItem
                            textValue="Delete provider"
                            className="provider-menu-item provider-menu-danger"
                            onAction={() => onDelete(item)}
                          >
                            <Icon name="trash" /> Delete provider
                          </MenuItem>
                        </Menu>
                      </Popover>
                    </MenuTrigger>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleProviders.length === 0 && (
          <EmptyState
            className="providers-empty"
            icon={providers.length ? "search" : "providers"}
            iconClassName="providers-empty-symbol"
            title={providers.length ? "No matching providers" : "Connect your first provider"}
            titleLevel="h3"
            description={
              providers.length
                ? "Try another name, model, or endpoint."
                : "Add a provider connection to run a security scan or generate a fix prompt."
            }
            descriptionClassName="muted"
          >
            {providers.length > 0 && (
              <Button className="button button-secondary" onClick={() => onQueryChange("")}>
                Clear search
              </Button>
            )}
          </EmptyState>
        )}
      </div>
    </>
  );
}

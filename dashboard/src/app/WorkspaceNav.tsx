import { NavLink } from "react-router";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { pages } from "./routes.ts";

export function WorkspaceNav({
  findingCount,
  historyCount,
}: {
  findingCount: number;
  historyCount: number;
}) {
  const navigationScrollbars = useElementScrollbars<HTMLElement>("x");
  return (
    <div className="workspace-nav-row">
      <nav
        ref={navigationScrollbars}
        data-overlayscrollbars-initialize=""
        aria-label="Workspace navigation"
      >
        {pages.map((page) => (
          <NavLink
            key={page.id}
            to={page.path}
            end={page.end}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            <Icon name={page.id} />
            <span>{page.label}</span>
            {page.id === "findings" && (
              <span className="nav-count">
                <MorphNumber value={findingCount} />
              </span>
            )}
            {page.id === "history" && (
              <span className="nav-count">
                <MorphNumber value={historyCount} />
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

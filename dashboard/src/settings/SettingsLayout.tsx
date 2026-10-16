import { NavLink, Outlet } from "react-router";
import { routes } from "../app/routes.ts";
import { Icon } from "../shared/icons.tsx";

export function SettingsLayout() {
  return (
    <section className="security-settings">
      <header className="security-page-heading">
        <div>
          <h1>Settings</h1>
          <p>Manage appearance, model connections and saved workspace data.</p>
        </div>
      </header>
      <div className="subnav-layout">
        <aside className="subnav">
          <p className="eyebrow">Workspace settings</p>
          <nav className="subnav-list" aria-label="Settings categories">
            <NavLink to={routes.appearance} className="subnav-item">
              <Icon name="sun" /> Appearance
            </NavLink>
            <NavLink to={routes.providers} className="subnav-item">
              <Icon name="providers" /> Providers
            </NavLink>
            <NavLink to={routes.data} className="subnav-item">
              <Icon name="data-stores" /> Data
            </NavLink>
          </nav>
        </aside>
        <Outlet />
      </div>
    </section>
  );
}

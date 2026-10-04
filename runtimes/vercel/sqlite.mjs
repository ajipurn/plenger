import { state } from "/opt/plenger/bridge.mjs";
import Database from "/opt/plenger/node_modules/better-sqlite3/lib/index.js";
export default class ManagedDatabase extends Database {
  constructor(_filename, options) {
    if (state.databases.length) throw new Error("One SQLite store per profile.");
    super("/tmp/plenger-booking.sqlite", options);
    state.databases.push(this);
  }
  prepare(...args) {
    const statement = super.prepare(...args);
    if (!statement.readonly)
      for (const method of ["run", "get", "all"]) {
        const original = statement[method];
        statement[method] = function (...parameters) {
          try {
            return original.apply(this, parameters);
          } finally {
            state.observeDatabase?.();
          }
        };
      }
    return statement;
  }
  exec(...args) {
    try {
      return super.exec(...args);
    } finally {
      state.observeDatabase?.();
    }
  }
  transaction(...args) {
    const transaction = super.transaction(...args);
    const properties = { database: { value: this, enumerable: true } };
    for (const mode of ["default", "deferred", "immediate", "exclusive"]) {
      const original = transaction[mode];
      properties[mode] = {
        value: function (...parameters) {
          try {
            return original.apply(this, parameters);
          } finally {
            state.observeDatabase?.();
          }
        },
      };
    }
    // Preserve better-sqlite3's shared mode functions and database property.
    for (const mode of ["default", "deferred", "immediate", "exclusive"])
      Object.defineProperties(properties[mode].value, properties);
    return properties.default.value;
  }
}

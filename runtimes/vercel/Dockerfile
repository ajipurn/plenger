FROM docker.io/library/node:22.18.0-bookworm@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2
WORKDIR /opt/plenger
COPY --chmod=0444 package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node node_modules/esbuild/install.js \
 && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --directory node_modules/better-sqlite3 --nodedir=/usr/local \
 && npm cache clean --force
COPY --chmod=0444 worker.mjs bridge.mjs ai.mjs google.mjs sqlite.mjs ./
USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["node", "/opt/plenger/worker.mjs"]

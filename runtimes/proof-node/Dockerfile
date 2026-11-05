FROM docker.io/library/node:22.23.4-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
WORKDIR /opt/plenger
COPY --chmod=0444 package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chmod=0444 proof.mjs case.mjs ./
USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["node", "/opt/plenger/proof.mjs"]

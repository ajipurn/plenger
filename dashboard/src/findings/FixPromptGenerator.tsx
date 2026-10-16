import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import type { FixPromptResult, ImportedReaEvidence } from "../../../src/dashboard/contract.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { routes } from "../app/routes.ts";
import { errorMessage } from "../shared/async.ts";
import { Button, Select, TextArea } from "../shared/ui.tsx";

export function FixPromptGenerator({
  scanId,
  fingerprint,
  providers,
  reaEvidence,
  reviewId,
}: {
  scanId: string;
  fingerprint: string;
  providers: SavedProvider[];
  reaEvidence: ImportedReaEvidence[];
  reviewId?: string;
}) {
  const api = useApi();
  const providerLabel = useId();
  const promptLabel = useId();
  const evidenceLabel = useId();
  const controller = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [providerId, setProviderId] = useState(
    () => (providers.find((provider) => provider.isDefault) ?? providers[0])?.id ?? "",
  );
  const [result, setResult] = useState<FixPromptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [evidenceId, setEvidenceId] = useState("none");
  const selectedEvidence = reaEvidence.find((item) => item.id === evidenceId);
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];

  useEffect(() => () => controller.current?.abort(), []);

  async function generate() {
    if (!api || !provider || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError("");
    setCopyStatus("");
    setResult(null);
    try {
      const next = await api.generateFixPrompt(
        {
          scanId,
          fingerprint,
          providerId: provider.id,
          ...(reviewId ? { reviewId } : {}),
          ...(selectedEvidence ? { reaEvidenceId: selectedEvidence.id } : {}),
        },
        current.signal,
      );
      if (!current.signal.aborted) setResult(next);
    } catch (failure) {
      if (!current.signal.aborted)
        setError(errorMessage(failure, "Unable to generate a fix prompt."));
    } finally {
      if (!current.signal.aborted) setBusy(false);
      if (controller.current === current) controller.current = null;
    }
  }

  async function copy() {
    if (result?.status !== "generated") return;
    try {
      await navigator.clipboard.writeText(result.prompt);
      setCopyStatus("Prompt copied. Paste it into your coding agent.");
    } catch {
      textarea.current?.focus();
      textarea.current?.select();
      setCopyStatus("Text selected. Use your keyboard's copy command to copy the prompt.");
    }
  }

  return (
    <section className="detail-section fix-prompt-panel">
      <h4>Fix with a coding agent</h4>
      <p className="muted">
        Generate instructions to investigate and fix this finding, then copy them into your coding
        agent.
      </p>
      {provider ? (
        <>
          {reaEvidence.length > 0 && (
            <div className="fix-prompt-evidence">
              <label htmlFor={evidenceLabel}>REA evidence (optional)</label>
              <Select
                label="REA evidence"
                id={evidenceLabel}
                value={selectedEvidence?.id ?? "none"}
                items={[
                  { value: "none", label: "None" },
                  ...reaEvidence.map((item) => ({ value: item.id, label: item.filename })),
                ]}
                disabled={busy}
                onValueChange={(id) => {
                  setEvidenceId(id);
                  setResult(null);
                  setError("");
                  setCopyStatus("");
                }}
              />
              {selectedEvidence && (
                <p className="muted fix-prompt-disclosure">
                  Includes a bounded excerpt of this unverified import. The coding agent must check
                  that it matches the repository and build.
                </p>
              )}
            </div>
          )}
          <div className="fix-prompt-controls">
            <div className="fix-prompt-provider">
              <label htmlFor={providerLabel}>Provider</label>
              <Select
                label="Provider"
                id={providerLabel}
                value={provider.id}
                items={providers.map((item) => ({ value: item.id, label: item.name }))}
                onValueChange={(id) => {
                  setProviderId(id);
                  setResult(null);
                  setError("");
                  setCopyStatus("");
                }}
                disabled={busy}
              />
            </div>
            <Button
              className="button button-primary"
              onClick={() => void generate()}
              disabled={!api || busy}
            >
              {busy ? "Generating prompt…" : result ? "Regenerate prompt" : "Generate fix prompt"}
            </Button>
          </div>
          <p className="fix-prompt-disclosure muted">
            Sends this finding's redacted evidence
            {selectedEvidence ? " and selected REA context" : ""} to {provider.name}. Uses your
            saved model settings. No code is changed.
          </p>
        </>
      ) : (
        <p className="fix-prompt-setup">
          <Link to={routes.providers}>Add a provider</Link> to generate a fix prompt.
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {result?.status === "refused" && (
        <p className="error-message" role="alert">
          The provider declined to generate a fix prompt. {result.reason}
        </p>
      )}
      {result?.status === "generated" && (
        <div className="fix-prompt-result">
          <div className="fix-prompt-result-heading">
            <label htmlFor={promptLabel}>Coding agent prompt</label>
            <Button className="button button-secondary" onClick={() => void copy()}>
              Copy prompt
            </Button>
          </div>
          <TextArea
            id={promptLabel}
            ref={textarea}
            className="fix-prompt-text"
            value={result.prompt}
            readOnly
            rows={12}
            spellCheck={false}
          />
          <p className="muted fix-prompt-disclosure">
            Generated by {result.provider.name} · {result.provider.model}. Review the prompt before
            using it.
          </p>
        </div>
      )}
      <p className="fix-prompt-status muted" role="status">
        {busy
          ? "Generating a prompt from this finding's saved evidence…"
          : copyStatus || (result?.status === "generated" ? "Fix prompt ready to copy." : "")}
      </p>
    </section>
  );
}

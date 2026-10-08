import { ActionForm } from "@/components/action-form";
import { Card, Field, Select } from "@/components/ui";
import { aiMode } from "@/server/ai/provider";
import { createFromContractAction } from "../actions";

/** Starts a draft file from an uploaded agreement; extracted values become proposals for officer review. */
export function ContractIntake() {
  const mode = aiMode();
  return (
    <Card title="Start from a purchase agreement" description="Creates a draft file and proposes fields, parties, property and deadlines from the document. Nothing becomes authoritative until an officer accepts it.">
      <ActionForm action={createFromContractAction} submitLabel="Upload and extract" pendingLabel="Uploading, scanning and extracting…">
        <Field label="Transaction type" htmlFor="intake-type">
          <Select id="intake-type" name="type" defaultValue="RESIDENTIAL">
            <option value="RESIDENTIAL">Residential</option>
            <option value="COMMERCIAL">Commercial</option>
          </Select>
        </Field>
        <Field label="Executed agreement (PDF or image)" htmlFor="intake-file" required>
          <input id="intake-file" type="file" name="file" required accept="application/pdf,image/png,image/jpeg,image/webp,image/tiff" className="block w-full text-sm" />
        </Field>
      </ActionForm>
      <p className="mt-3 text-xs text-slate-500">
        {mode === "LIVE" ? "Extraction uses the configured Anthropic model on the server." : "Demo mode: extraction uses rule-based patterns, not AI. Scanned files cannot be read without the Anthropic provider."}
      </p>
    </Card>
  );
}

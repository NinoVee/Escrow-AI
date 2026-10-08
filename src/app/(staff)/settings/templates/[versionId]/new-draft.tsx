"use client";

import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { newDraftAction } from "../../actions";

export function NewDraftButton({ templateId, fromVersionId }: { templateId: string; fromVersionId: string }) {
  const router = useRouter();
  return (
    <ActionForm
      action={newDraftAction.bind(null, templateId, fromVersionId)}
      submitLabel="Create editable draft"
      variant="secondary"
      onSuccess={(s) => {
        if (s.ok && s.data && typeof s.data === "object" && "id" in s.data) router.push(`/settings/templates/${(s.data as { id: string }).id}`);
      }}
    >
      {null}
    </ActionForm>
  );
}

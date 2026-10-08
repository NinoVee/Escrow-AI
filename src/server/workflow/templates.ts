import type { Prerequisite, TaskTemplate, WorkflowDefinition } from "./definition";

/**
 * Default California pilot templates. These are EDITABLE STARTING POINTS that
 * reflect common escrow practice; they are not a statement of what California
 * law requires. Each company must review and adapt them to its own escrow
 * instructions, licensing obligations and procedures before relying on them.
 */

export const STANDARD_STAGES = [
  { key: "DRAFT", label: "Draft", description: "File being set up; not yet opened." },
  { key: "OPEN", label: "Open", description: "Escrow opened and instructions received." },
  { key: "DOCUMENT_COLLECTION", label: "Document collection" },
  { key: "REVIEW", label: "Review" },
  { key: "READY_FOR_SIGNING", label: "Ready for signing" },
  { key: "SIGNED", label: "Signed" },
  { key: "FUNDING_REVIEW", label: "Funding review" },
  { key: "READY_FOR_RECORDING", label: "Ready for recording" },
  { key: "RECORDED", label: "Recorded" },
  { key: "DISBURSEMENT_REVIEW", label: "Disbursement review" },
  { key: "CLOSED", label: "Closed" },
];

const strict = (p: Prerequisite): Prerequisite => ({ ...p, overridable: false });

/** Hard rules for closing; never overridable. */
export const CLOSING_HARD_RULES: Prerequisite[] = [
  strict({ type: "TASKS_RESOLVED", overridable: false }),
  strict({ type: "NO_OPEN_BLOCKERS", overridable: false }),
  strict({ type: "NO_UNRESOLVED_CONFLICTS", overridable: false }),
  strict({ type: "NO_PENDING_PROPOSALS", overridable: false }),
  strict({ type: "MILESTONE_COMPLETE", kind: "SIGNING", overridable: false }),
  strict({ type: "MILESTONE_COMPLETE", kind: "FUNDING", overridable: false }),
  strict({ type: "MILESTONE_COMPLETE", kind: "RECORDING", overridable: false }),
  strict({ type: "MILESTONE_COMPLETE", kind: "DISBURSEMENT", overridable: false }),
  strict({ type: "FILE_BALANCE_ZERO", overridable: false }),
  strict({ type: "NO_OPEN_DISBURSEMENTS", overridable: false }),
];

type PrereqInput = Prerequisite extends infer P ? (P extends { overridable: boolean } ? Omit<P, "overridable"> : never) : never;

function standardTransitions(extraReview: Prerequisite[] = []): WorkflowDefinition["transitions"] {
  const p = (x: PrereqInput): Prerequisite => ({ overridable: true, ...x }) as Prerequisite;
  return [
    {
      from: "DRAFT",
      to: "OPEN",
      label: "Open escrow",
      prerequisites: [
        p({ type: "PROPERTY_PRESENT" }),
        p({ type: "OFFICER_ASSIGNED" }),
        p({ type: "PARTICIPANT_ROLES", roles: ["BUYER", "SELLER"] }),
      ],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "OPEN",
      to: "DOCUMENT_COLLECTION",
      prerequisites: [p({ type: "TASKS_RESOLVED", stages: ["OPEN"] }), p({ type: "FIELDS_PRESENT", fields: ["purchasePriceCents", "proposedClosingDate"] })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "DOCUMENT_COLLECTION",
      to: "REVIEW",
      prerequisites: [p({ type: "TASKS_RESOLVED", stages: ["DOCUMENT_COLLECTION"] })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    { from: "REVIEW", to: "DOCUMENT_COLLECTION", label: "Return to document collection", prerequisites: [], requiresApproval: false, approverPermission: "approval.stage" },
    {
      from: "REVIEW",
      to: "READY_FOR_SIGNING",
      prerequisites: [
        p({ type: "TASKS_RESOLVED", stages: ["REVIEW"] }),
        p({ type: "NO_PENDING_PROPOSALS" }),
        p({ type: "NO_UNRESOLVED_CONFLICTS" }),
        p({ type: "TITLE_EXCEPTIONS_DISPOSITIONED" }),
        p({ type: "SIGNERS_APPROVED" }),
        p({ type: "NO_OPEN_BLOCKERS" }),
        ...extraReview,
      ],
      requiresApproval: true,
      approverPermission: "approval.stage",
    },
    { from: "READY_FOR_SIGNING", to: "REVIEW", label: "Return to review", prerequisites: [], requiresApproval: false, approverPermission: "approval.stage" },
    {
      from: "READY_FOR_SIGNING",
      to: "SIGNED",
      prerequisites: [strict({ type: "MILESTONE_COMPLETE", kind: "SIGNING", overridable: false })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "SIGNED",
      to: "FUNDING_REVIEW",
      prerequisites: [p({ type: "TASKS_RESOLVED", stages: ["READY_FOR_SIGNING", "SIGNED"] })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "FUNDING_REVIEW",
      to: "READY_FOR_RECORDING",
      prerequisites: [
        strict({ type: "MILESTONE_COMPLETE", kind: "FUNDING", overridable: false }),
        p({ type: "TASKS_RESOLVED", stages: ["FUNDING_REVIEW"] }),
        p({ type: "NO_OPEN_BLOCKERS" }),
      ],
      requiresApproval: true,
      approverPermission: "approval.stage",
    },
    {
      from: "READY_FOR_RECORDING",
      to: "RECORDED",
      prerequisites: [strict({ type: "MILESTONE_COMPLETE", kind: "RECORDING", overridable: false })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "RECORDED",
      to: "DISBURSEMENT_REVIEW",
      prerequisites: [p({ type: "TASKS_RESOLVED", stages: ["READY_FOR_RECORDING", "RECORDED"] })],
      requiresApproval: false,
      approverPermission: "approval.stage",
    },
    {
      from: "DISBURSEMENT_REVIEW",
      to: "CLOSED",
      label: "Close file",
      prerequisites: [...CLOSING_HARD_RULES, p({ type: "NO_PENDING_APPROVALS" })],
      requiresApproval: true,
      approverPermission: "approval.stage",
    },
  ];
}

const t = (x: Partial<TaskTemplate> & Pick<TaskTemplate, "key" | "title" | "stage">): TaskTemplate => ({
  category: "GENERAL",
  required: false,
  isBlocker: false,
  requiresApproval: false,
  ...x,
});

const RESIDENTIAL_TASKS: TaskTemplate[] = [
  // Opening
  t({ key: "open-file", title: "Open escrow file and confirm escrow instructions received", stage: "OPEN", category: "OPENING", required: true, assigneeRole: "ASSISTANT", dueRule: { anchor: "OPENED", offsetDays: 1 } }),
  t({ key: "upload-contract", title: "Upload fully executed purchase agreement and counteroffers", stage: "OPEN", category: "CONTRACT", required: true, dueRule: { anchor: "OPENED", offsetDays: 1 } }),
  t({ key: "review-contract", title: "Review purchase agreement terms and accept extracted fields", stage: "OPEN", category: "CONTRACT", required: true, assigneeRole: "OFFICER", dueRule: { anchor: "OPENED", offsetDays: 2 } }),
  t({ key: "record-deposit", title: "Record receipt of initial deposit", description: "Record the deposit receipt in the file ledger once funds are confirmed received. Timing follows the contract terms.", stage: "OPEN", category: "DEPOSIT", required: true, dueRule: { anchor: "ACCEPTANCE", offsetDays: 3 } }),
  t({ key: "send-opening-package", title: "Send opening package and portal invitations", stage: "OPEN", category: "COMMUNICATION", dueRule: { anchor: "OPENED", offsetDays: 2 } }),
  // Document collection
  t({ key: "buyer-information", title: "Collect buyer information statement", stage: "DOCUMENT_COLLECTION", category: "PARTY_INFO", required: true, dueRule: { anchor: "OPENED", offsetDays: 7 } }),
  t({ key: "seller-information", title: "Collect seller information statement", stage: "DOCUMENT_COLLECTION", category: "PARTY_INFO", required: true, dueRule: { anchor: "OPENED", offsetDays: 7 } }),
  t({ key: "order-title", title: "Order preliminary title report", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true, dueRule: { anchor: "OPENED", offsetDays: 1 } }),
  t({ key: "upload-title-report", title: "Upload preliminary title report", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true, dueRule: { anchor: "OPENED", offsetDays: 7 } }),
  t({ key: "review-title-exceptions", title: "Review title exceptions and record dispositions", description: "Disposition each exception (e.g. to be paid off, buyer approved). This is an escrow tracking step, not a title examination.", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true, assigneeRole: "OFFICER" }),
  t({ key: "payoff-requests", title: "Request payoff statements for existing liens", stage: "DOCUMENT_COLLECTION", category: "PAYOFF", required: true, applicabilityNote: "Mark not applicable if the title report shows no monetary liens to be paid through escrow." }),
  t({ key: "hoa-demand", title: "Request HOA documents and demand statement", stage: "DOCUMENT_COLLECTION", category: "HOA", required: true, when: { hasHoa: true } }),
  t({ key: "lender-instructions", title: "Receive lender escrow instructions", stage: "DOCUMENT_COLLECTION", category: "FINANCING", required: true, when: { financed: true } }),
  t({ key: "loan-approval", title: "Track loan approval and loan contingency", stage: "DOCUMENT_COLLECTION", category: "FINANCING", when: { financed: true } }),
  t({ key: "appraisal", title: "Track appraisal", stage: "DOCUMENT_COLLECTION", category: "FINANCING", when: { financed: true } }),
  t({ key: "contingency-removals", title: "Collect contingency removals or confirm contingency status", stage: "DOCUMENT_COLLECTION", category: "CONTRACT", required: true }),
  t({ key: "review-amendments", title: "Review amendments and addenda", stage: "DOCUMENT_COLLECTION", category: "CONTRACT", applicabilityNote: "Applies when amendments are received." }),
  t({ key: "entity-signers", title: "Review authority of entity signers", stage: "DOCUMENT_COLLECTION", category: "ENTITY", required: true, when: { hasEntityParty: true } }),
  // Review
  t({ key: "estimated-statement", title: "Prepare estimated settlement statement", stage: "REVIEW", category: "SETTLEMENT", required: true }),
  t({ key: "officer-file-review", title: "Officer review of file and documents", stage: "REVIEW", category: "REVIEW", required: true, assigneeRole: "OFFICER" }),
  // Signing
  t({ key: "schedule-signing", title: "Coordinate signing appointments", stage: "READY_FOR_SIGNING", category: "SIGNING", required: true }),
  t({ key: "signing-package", title: "Prepare signing package for review", stage: "READY_FOR_SIGNING", category: "SIGNING", required: true }),
  t({ key: "return-loan-docs", title: "Return signed loan documents to lender", stage: "SIGNED", category: "FINANCING", required: true, when: { financed: true } }),
  // Funding
  t({ key: "buyer-funds", title: "Confirm buyer closing funds received through an approved source", stage: "FUNDING_REVIEW", category: "FUNDING", required: true }),
  t({ key: "lender-funding", title: "Confirm lender funding", stage: "FUNDING_REVIEW", category: "FUNDING", required: true, when: { financed: true } }),
  t({ key: "funding-signoff", title: "Funding review sign-off", stage: "FUNDING_REVIEW", category: "FUNDING", required: true, assigneeRole: "OFFICER" }),
  // Recording
  t({ key: "authorize-recording", title: "Authorize recording with title company", stage: "READY_FOR_RECORDING", category: "RECORDING", required: true, assigneeRole: "OFFICER" }),
  t({ key: "recording-confirmation", title: "Upload recording confirmation", stage: "RECORDED", category: "RECORDING", required: true }),
  // Disbursement and close
  t({ key: "final-statement", title: "Finalize settlement statement", stage: "DISBURSEMENT_REVIEW", category: "SETTLEMENT", required: true }),
  t({ key: "prepare-disbursements", title: "Prepare disbursements for approval", stage: "DISBURSEMENT_REVIEW", category: "DISBURSEMENT", required: true }),
  t({ key: "final-package", title: "Send final closing package", stage: "DISBURSEMENT_REVIEW", category: "CLOSING", required: true }),
  t({ key: "archive-file", title: "Archive file and confirm retention settings", stage: "DISBURSEMENT_REVIEW", category: "CLOSING" }),
];

const COMMERCIAL_TASKS: TaskTemplate[] = [
  t({ key: "open-file", title: "Open escrow file and confirm escrow instructions received", stage: "OPEN", category: "OPENING", required: true, dueRule: { anchor: "OPENED", offsetDays: 1 } }),
  t({ key: "upload-contract", title: "Upload executed purchase and sale agreement and amendments", stage: "OPEN", category: "CONTRACT", required: true }),
  t({ key: "review-contract", title: "Review PSA terms and accept extracted fields", stage: "OPEN", category: "CONTRACT", required: true, assigneeRole: "OFFICER" }),
  t({ key: "record-deposit", title: "Record receipt of earnest money deposit", stage: "OPEN", category: "DEPOSIT", required: true, dueRule: { anchor: "ACCEPTANCE", offsetDays: 3 } }),
  t({ key: "confirm-parcels", title: "Confirm all properties and parcel numbers", stage: "OPEN", category: "PROPERTY", required: true }),
  // Entities and authority
  t({ key: "entity-documents", title: "Collect entity documents (formation, governing documents, good standing)", stage: "DOCUMENT_COLLECTION", category: "ENTITY", required: true, when: { hasEntityParty: true } }),
  t({ key: "signing-authority", title: "Review signing authority (resolutions, incumbency, trust certifications)", description: "A human reviewer must approve each authorized signer. The AI assistant cannot approve signing authority.", stage: "DOCUMENT_COLLECTION", category: "ENTITY", required: true, requiresApproval: true, when: { hasEntityParty: true } }),
  // Due diligence
  t({ key: "due-diligence-period", title: "Track due diligence period and buyer approval or termination", stage: "DOCUMENT_COLLECTION", category: "DUE_DILIGENCE", required: true }),
  t({ key: "survey", title: "Obtain survey", stage: "DOCUMENT_COLLECTION", category: "DUE_DILIGENCE", applicabilityNote: "Applies when the buyer, lender or title company requires a survey." }),
  t({ key: "environmental", title: "Obtain environmental report", stage: "DOCUMENT_COLLECTION", category: "DUE_DILIGENCE", applicabilityNote: "Applies when required by the agreement or lender." }),
  t({ key: "order-title", title: "Order title commitment / preliminary report", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true }),
  t({ key: "upload-title-report", title: "Upload title commitment and underlying documents", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true }),
  t({ key: "review-title-exceptions", title: "Review title exceptions and record dispositions", stage: "DOCUMENT_COLLECTION", category: "TITLE", required: true }),
  // Tenancy
  t({ key: "leases", title: "Collect leases and amendments", stage: "DOCUMENT_COLLECTION", category: "LEASES", required: true, when: { hasTenants: true } }),
  t({ key: "rent-roll", title: "Collect certified rent roll", stage: "DOCUMENT_COLLECTION", category: "LEASES", required: true, when: { hasTenants: true } }),
  t({ key: "estoppels", title: "Collect tenant estoppel certificates", stage: "DOCUMENT_COLLECTION", category: "LEASES", required: true, when: { hasTenants: true }, applicabilityNote: "Number and form per the agreement." }),
  t({ key: "sndas", title: "Collect SNDAs required by lender", stage: "DOCUMENT_COLLECTION", category: "LEASES", when: { hasTenants: true, financed: true } }),
  // Financing and payoffs
  t({ key: "payoff-instructions", title: "Obtain payoff instructions for each existing loan", stage: "DOCUMENT_COLLECTION", category: "PAYOFF", required: true, applicabilityNote: "Mark not applicable if there is no existing financing." }),
  t({ key: "lender-instructions", title: "Receive lender escrow instructions (each new loan)", stage: "DOCUMENT_COLLECTION", category: "FINANCING", required: true, when: { financed: true } }),
  t({ key: "lender-review", title: "Lender review of closing documents", stage: "REVIEW", category: "FINANCING", required: true, when: { financed: true } }),
  t({ key: "attorney-review", title: "Attorney review of closing documents", stage: "REVIEW", category: "REVIEW", applicabilityNote: "Applies when a party is represented by counsel." }),
  // 1031
  t({ key: "exchange-coordination", title: "Coordinate with qualified intermediary", stage: "DOCUMENT_COLLECTION", category: "EXCHANGE_1031", required: true, when: { is1031Exchange: true } }),
  t({ key: "exchange-documents", title: "Collect exchange assignment and notices", stage: "REVIEW", category: "EXCHANGE_1031", required: true, when: { is1031Exchange: true } }),
  // Review
  t({ key: "settlement-allocations", title: "Confirm custom settlement allocations and prorations", stage: "REVIEW", category: "SETTLEMENT", required: true }),
  t({ key: "holdbacks", title: "Document holdbacks and post-closing obligations", stage: "REVIEW", category: "SETTLEMENT", applicabilityNote: "Applies when the agreement provides for holdbacks or post-closing obligations." }),
  t({ key: "officer-file-review", title: "Officer review of file and documents", stage: "REVIEW", category: "REVIEW", required: true }),
  // Signing → close
  t({ key: "schedule-signing", title: "Coordinate execution of closing documents", stage: "READY_FOR_SIGNING", category: "SIGNING", required: true }),
  t({ key: "buyer-funds", title: "Confirm buyer funds received through an approved source", stage: "FUNDING_REVIEW", category: "FUNDING", required: true }),
  t({ key: "lender-funding", title: "Confirm funding of each new loan", stage: "FUNDING_REVIEW", category: "FUNDING", required: true, when: { financed: true } }),
  t({ key: "funding-signoff", title: "Funding review sign-off", stage: "FUNDING_REVIEW", category: "FUNDING", required: true }),
  t({ key: "authorize-recording", title: "Authorize recording with title company", stage: "READY_FOR_RECORDING", category: "RECORDING", required: true }),
  t({ key: "recording-confirmation", title: "Upload recording confirmation (all parcels)", stage: "RECORDED", category: "RECORDING", required: true }),
  t({ key: "final-statement", title: "Finalize settlement statement", stage: "DISBURSEMENT_REVIEW", category: "SETTLEMENT", required: true }),
  t({ key: "prepare-disbursements", title: "Prepare disbursements for approval", stage: "DISBURSEMENT_REVIEW", category: "DISBURSEMENT", required: true }),
  t({ key: "post-closing", title: "Track post-closing obligations and holdback releases", stage: "DISBURSEMENT_REVIEW", category: "POST_CLOSING" }),
  t({ key: "final-package", title: "Send final closing package", stage: "DISBURSEMENT_REVIEW", category: "CLOSING", required: true }),
];

const MILESTONES: WorkflowDefinition["milestones"] = [
  { kind: "SIGNING" },
  { kind: "FUNDING" },
  { kind: "RECORDING" },
  { kind: "DISBURSEMENT" },
];

const DISCLAIMER =
  "Template steps reflect common practice and must be adapted to the company's escrow instructions and procedures. Not every step is legally required in every file.";

export const DEFAULT_TEMPLATES: {
  key: string;
  name: string;
  transactionType: "RESIDENTIAL" | "COMMERCIAL";
  jurisdiction: string;
  description: string;
  definition: WorkflowDefinition;
}[] = [
  {
    key: "ca-residential",
    name: "California residential resale",
    transactionType: "RESIDENTIAL",
    jurisdiction: "US-CA",
    description: "Pilot template for California residential resale escrows.",
    definition: {
      stages: STANDARD_STAGES,
      initialStage: "DRAFT",
      closedStage: "CLOSED",
      reopenStage: "DISBURSEMENT_REVIEW",
      transitions: standardTransitions(),
      tasks: RESIDENTIAL_TASKS,
      milestones: MILESTONES,
      disclaimer: DISCLAIMER,
    },
  },
  {
    key: "ca-commercial",
    name: "California commercial sale",
    transactionType: "COMMERCIAL",
    jurisdiction: "US-CA",
    description: "Pilot template for commercial transactions with entities, multiple parcels, tenants and 1031 exchanges.",
    definition: {
      stages: STANDARD_STAGES,
      initialStage: "DRAFT",
      closedStage: "CLOSED",
      reopenStage: "DISBURSEMENT_REVIEW",
      transitions: standardTransitions(),
      tasks: COMMERCIAL_TASKS,
      milestones: MILESTONES,
      disclaimer: DISCLAIMER,
    },
  },
];

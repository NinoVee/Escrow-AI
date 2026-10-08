/**
 * FICTIONAL demo accounts for local development only. These credentials are
 * published in the README and must never exist in a production database.
 * Emails use reserved example domains (RFC 2606).
 */
export const DEMO_PASSWORD = "EscrowFlow-Demo-2026!";

/** Raw TOTP secret shared by all demo staff accounts (demo only). */
export const DEMO_TOTP_SECRET = "escrowflow-demo-totp-secret-0001";

export const DEMO_STAFF = [
  { key: "admin", email: "admin@goldenoak.example", name: "Avery Lindqvist", role: "COMPANY_ADMIN", company: "golden-oak" },
  { key: "officer", email: "officer@goldenoak.example", name: "Morgan Ellison", role: "ESCROW_OFFICER", company: "golden-oak" },
  { key: "officer2", email: "officer2@goldenoak.example", name: "Jordan Reyes", role: "ESCROW_OFFICER", company: "golden-oak" },
  { key: "assistant", email: "assistant@goldenoak.example", name: "Sam Okafor", role: "ESCROW_ASSISTANT", company: "golden-oak" },
  { key: "accounting", email: "accounting@goldenoak.example", name: "Casey Brandt", role: "ACCOUNTING", company: "golden-oak" },
  { key: "accounting2", email: "accounting2@goldenoak.example", name: "Taylor Huang", role: "ACCOUNTING", company: "golden-oak" },
  { key: "manager", email: "manager@goldenoak.example", name: "Riley Castellanos", role: "MANAGER", company: "golden-oak" },
  { key: "harborOfficer", email: "officer@harborline.example", name: "Quinn Harper", role: "ESCROW_OFFICER", company: "harbor-line" },
  { key: "harborAdmin", email: "admin@harborline.example", name: "Drew Patel", role: "COMPANY_ADMIN", company: "harbor-line" },
] as const;

export const DEMO_EXTERNAL = [
  { key: "buyer", email: "buyer@example.com", name: "Priya Natarajan" },
  { key: "seller", email: "seller@example.com", name: "Daniel Whitfield" },
  { key: "lender", email: "loanofficer@example.net", name: "Elena Marsh" },
  { key: "creBuyerRep", email: "manager@bayline.example.org", name: "Marcus Delgado" },
] as const;

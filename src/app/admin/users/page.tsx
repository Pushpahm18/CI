import { redirect } from "next/navigation";

// Moved: there is no separate Admin area in CI (BRD 1.1 — Corporate Marketing manages these screens).
export default function MovedPage() {
  redirect("/user-management");
}

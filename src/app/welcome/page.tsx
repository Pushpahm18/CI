import { redirect } from "next/navigation";

// There is no welcome page in CI; old links and bookmarks to /welcome
// go to the CI landing route instead.
export default function WelcomeRedirect() {
  redirect("/");
}

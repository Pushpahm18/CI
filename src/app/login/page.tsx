import Image from "next/image";
import { redirect } from "next/navigation";
import { LogIn } from "lucide-react";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { DEV_MOCK_PROVIDER_ID, isDevMockAuthEnabled } from "@/server/dev-auth";

// Phase 1 (Microsoft Login only): a branded CI entry point in front of
// Microsoft Entra ID sign-in, replacing Auth.js's own default login page
// (auth.ts's `pages.signIn: "/login"`). The "Sign in with Microsoft" button
// is a plain server-action form submit — no client-side JS/SessionProvider
// needed just to trigger sign-in — so this whole page can stay a Server
// Component; signIn() does the OAuth redirect itself.
//
// Layout: an ASM-branded hero (mark + product name, reversed-white per the brand
// guideline's own documented rule for the mark "on a solid Innovation
// Purple background" — see app-shell.tsx's sidebar logo comment for the
// same rule already applied there) sits on the purple field above the
// sign-in card, rather than squeezing both the full ASM wordmark and the
// product name into the card itself — the mark-alone + product-name
// pairing is exactly what the guideline calls using the mark "as a visual
// element in an environment that is already ASM branded." Colors/type
// throughout reuse this app's existing ASM design tokens (globals.css) —
// Innovation Purple, Silicon Sand, Optimistic Amber, and the Ubuntu heading
// font already established for every other screen from the same guideline.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  // Already signed in? Don't show the login screen again — go straight to
  // wherever the visit was headed (or the app's normal landing route).
  const session = await auth();
  const { callbackUrl } = await searchParams;
  if (session) {
    redirect(callbackUrl || "/");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-10 bg-sidebar-bg px-4 py-12">
      <div className="flex flex-col items-center gap-4 text-center">
        <Image src="/asm-mark-white.png" alt="ASM" width={267} height={293} priority className="h-16 w-auto" />
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-heading text-3xl font-bold tracking-tight text-sidebar-text">Competitive Intelligence</h1>
          <span className="nav-accent-gradient h-[3px] w-10 rounded-full" />
        </div>
        <p className="text-[13px] text-sidebar-text-muted">Competitive market share</p>
      </div>

      <div className="w-full max-w-sm rounded-xl bg-surface p-8 shadow-xl">
        <p className="mb-6 text-center text-[13px] text-muted">Sign in with your Microsoft account to continue.</p>

        <form
          action={async () => {
            "use server";
            // Local UI development only (server/dev-auth.ts); otherwise the real Entra flow.
            const provider = isDevMockAuthEnabled() ? DEV_MOCK_PROVIDER_ID : "microsoft-entra-id";
            await signIn(provider, { redirectTo: callbackUrl || "/" });
          }}
        >
          <Button type="submit" className="w-full" size="lg">
            <LogIn className="h-4 w-4" /> Sign in with Microsoft
          </Button>
        </form>
      </div>
    </div>
  );
}

import { Outlet } from "react-router";
import { AppHeader } from "@/widgets/app-header";

// The frame around every page: header on top, the routed page below.
export function AppLayout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <AppHeader />
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

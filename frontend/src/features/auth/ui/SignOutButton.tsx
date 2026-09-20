import { LogOut } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { useAuthStore } from "../model/store-context";

export function SignOutButton() {
  const auth = useAuthStore();
  return (
    <Button variant="outline" size="sm" onClick={() => void auth.signOut()}>
      <LogOut aria-hidden="true" />
      Sign out
    </Button>
  );
}
